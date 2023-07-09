import type { Activity } from 'wildebeest/backend/src/activitypub/activities'
import { isAnnounceActivity, isCreateActivity, PUBLIC_GROUP } from 'wildebeest/backend/src/activitypub/activities'
import { actorURL } from 'wildebeest/backend/src/activitypub/actors'
import * as actors from 'wildebeest/backend/src/activitypub/actors'
import * as outbox from 'wildebeest/backend/src/activitypub/actors/outbox'
import * as objects from 'wildebeest/backend/src/activitypub/objects'
import { isNote, type Note } from 'wildebeest/backend/src/activitypub/objects/note'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import * as errors from 'wildebeest/backend/src/errors'
import { loadExternalMastodonAccount } from 'wildebeest/backend/src/mastodon/account'
import { toMastodonStatusFromObject } from 'wildebeest/backend/src/mastodon/status'
import { toMastodonStatusFromRow } from 'wildebeest/backend/src/mastodon/status'
import type { MastodonStatus } from 'wildebeest/backend/src/types'
import type { ContextData } from 'wildebeest/backend/src/types/context'
import type { Env } from 'wildebeest/backend/src/types/env'
import { adjustLocalHostDomain } from 'wildebeest/backend/src/utils/adjustLocalHostDomain'
import { cors } from 'wildebeest/backend/src/utils/cors'
import type { Handle } from 'wildebeest/backend/src/utils/parse'
import { parseHandle } from 'wildebeest/backend/src/utils/parse'
import { NonNullableProps } from 'wildebeest/backend/src/utils/type'
import * as webfinger from 'wildebeest/backend/src/webfinger'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

export const onRequest: PagesFunction<Env, any, ContextData> = async ({ request, env, params }) => {
	return handleRequest(request, await getDatabase(env), params.id as string)
}

const DEFAULT_LIMIT = 20

export async function handleRequest(request: Request, db: Database, id: string): Promise<Response> {
	const handle = parseHandle(id)
	const url = new URL(request.url)
	const domain = url.hostname
	const offset = Number.parseInt(url.searchParams.get('offset') ?? '0')
	const limit = Math.abs(Number.parseInt(url.searchParams.get('limit') ?? '0')) || DEFAULT_LIMIT

	let withReplies: boolean | null = null
	if (url.searchParams.get('with-replies') !== null) {
		withReplies = url.searchParams.get('with-replies') === 'true'
	}
	let excludeReplies: boolean | null = null
	if (url.searchParams.get('exclude_replies') !== null) {
		excludeReplies = url.searchParams.get('exclude_replies') === 'true'
	}

	if (handle.domain === null || (handle.domain !== null && handle.domain === domain)) {
		// Retrieve the statuses from a local user
		return getLocalStatuses(request, db, handle, offset, withReplies ?? excludeReplies ?? false, limit)
	} else if (handle.domain !== null) {
		// Retrieve the statuses of a remote actor
		return getRemoteStatuses(request, { ...handle, domain: handle.domain }, db, limit)
	} else {
		return new Response('', { status: 403 })
	}
}

async function getRemoteStatuses(
	request: Request,
	handle: NonNullableProps<Handle, 'domain'>,
	db: Database,
	limit: number
): Promise<Response> {
	const url = new URL(request.url)
	const domain = url.hostname
	const isPinned = url.searchParams.get('pinned') === 'true'
	if (isPinned) {
		// TODO: pinned statuses are not implemented yet. Stub the endpoint
		// to avoid returning statuses that aren't pinned.
		return new Response(JSON.stringify([]), { headers })
	}

	const acct = `${handle.localPart}@${handle.domain}`
	const link = await webfinger.queryAcctLink(handle.domain, acct)
	if (link === null) {
		console.warn('link is null')
		return new Response('', { status: 404 })
	}

	const actor = await actors.getAndCache(link, db)

	const activities = await outbox.get(actor, limit)

	// TODO: use account
	// eslint-disable-next-line unused-imports/no-unused-vars
	const account = await loadExternalMastodonAccount(acct, actor)

	const promises = activities.items.map(async (activity: Activity) => {
		const actorId = objects.getAPId(activity.actor)
		const objectId = objects.getAPId(activity.object)

		if (isCreateActivity(activity)) {
			const res = await objects.cacheObject(domain, db, activity.object, actorId, objectId, false)
			return toMastodonStatusFromObject(db, res.object as Note, domain)
		}
		if (isAnnounceActivity(activity)) {
			let obj: objects.APObject

			const localObject = await objects.getObjectById(db, objectId)
			if (localObject === null) {
				try {
					// Object doesn't exists locally, we'll need to download it.
					const remoteObject = await objects.get<Note>(objectId)

					const res = await objects.cacheObject(domain, db, remoteObject, actorId, objectId, false)
					if (res === null) {
						return null
					}
					obj = res.object
				} catch (err: any) {
					console.warn(`failed to retrieve object ${objectId}: ${err.message}`)
					return null
				}
			} else {
				// Object already exists locally, we can just use it.
				obj = localObject
			}
			if (!isNote(obj)) {
				console.warn('object type is not "Note"', obj.type)
				return null
			}

			return toMastodonStatusFromObject(db, obj, domain)
		}

		// FIXME: support other Activities, like Update.
		console.warn(`unsupported activity type: ${activity.type}`)
	})
	const statuses = (await Promise.all(promises)).filter(Boolean)

	return new Response(JSON.stringify(statuses), { headers })
}

export async function getLocalStatuses(
	request: Request,
	db: Database,
	handle: Handle,
	offset: number,
	withReplies: boolean,
	limit: number
): Promise<Response> {
	const domain = new URL(request.url).hostname
	const actorId = actorURL(adjustLocalHostDomain(domain), handle.localPart)

	const QUERY = `
SELECT objects.*,
       actors.id as actor_id,
       actors.cdate as actor_cdate,
       actors.properties as actor_properties,
       outbox_objects.actor_id as publisher_actor_id,
       (SELECT count(*) FROM actor_favourites WHERE actor_favourites.object_id=objects.id) as favourites_count,
       (SELECT count(*) FROM actor_reblogs WHERE actor_reblogs.object_id=objects.id) as reblogs_count,
       (SELECT count(*) FROM actor_replies WHERE actor_replies.in_reply_to_object_id=objects.id) as replies_count
FROM outbox_objects
INNER JOIN objects ON objects.id=outbox_objects.object_id
INNER JOIN actors ON actors.id=outbox_objects.actor_id
WHERE objects.type='Note'
      ${withReplies ? '' : 'AND ' + db.qb.jsonExtractIsNull('objects.properties', 'inReplyTo')}
      AND outbox_objects.target = '${PUBLIC_GROUP}'
      AND outbox_objects.actor_id = ?1
      AND outbox_objects.cdate > ?2${db.qb.psqlOnly('::timestamp')}
ORDER by outbox_objects.published_date DESC
LIMIT ?3 OFFSET ?4
`

	const out: Array<MastodonStatus> = []

	const url = new URL(request.url)

	const isPinned = url.searchParams.get('pinned') === 'true'
	if (isPinned) {
		// TODO: pinned statuses are not implemented yet. Stub the endpoint
		// to avoid returning statuses that aren't pinned.
		return new Response(JSON.stringify(out), { headers })
	}

	let afterCdate = db.qb.epoch()
	const maxId = url.searchParams.get('max_id')
	if (maxId !== null) {
		// Client asked to retrieve statuses after the max_id
		// As opposed to Mastodon we don't use incremental ID but UUID, we need
		// to retrieve the cdate of the max_id row and only show the newer statuses.
		const row = await db
			.prepare('SELECT cdate FROM outbox_objects WHERE object_id=?')
			.bind(maxId)
			.first<{ cdate: string } | null>()
		if (!row) {
			return errors.statusNotFound(maxId)
		}
		afterCdate = row.cdate
	}

	const { success, error, results } = await db
		.prepare(QUERY)
		.bind(actorId.toString(), afterCdate, limit ?? DEFAULT_LIMIT, offset)
		.all()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}

	if (!results) {
		return new Response(JSON.stringify(out), { headers })
	}

	for (let i = 0, len = results.length; i < len; i++) {
		const status = await toMastodonStatusFromRow(domain, db, results[i])
		if (status !== null) {
			out.push(status)
		}
	}

	return new Response(JSON.stringify(out), { headers })
}
