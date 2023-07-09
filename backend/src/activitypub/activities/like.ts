// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-like

import { createActivityId, LikeActivity } from 'wildebeest/backend/src/activitypub/activities'
import { Actor, getActorById, getAndCache } from 'wildebeest/backend/src/activitypub/actors'
import { getAPId, getObjectById, originalActorIdSymbol } from 'wildebeest/backend/src/activitypub/objects'
import { Database } from 'wildebeest/backend/src/database'
import { insertLike } from 'wildebeest/backend/src/mastodon/like'
import { createNotification, sendLikeNotification } from 'wildebeest/backend/src/mastodon/notification'
import { JWK } from 'wildebeest/backend/src/webpush/jwk'

export function createLikeActivity(domain: string, actor: Actor, object: URL): LikeActivity {
	return {
		'@context': 'https://www.w3.org/ns/activitystreams',
		id: createActivityId(domain),
		type: 'Like',
		actor: actor.id,
		object,
	}
}

// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-like
export async function handleLikeActivity(activity: LikeActivity, db: Database, adminEmail: string, vapidKeys: JWK) {
	const objectId = getAPId(activity.object)
	const actorId = getAPId(activity.actor)

	const obj = await getObjectById(db, objectId)
	if (obj === null || !obj[originalActorIdSymbol]) {
		console.warn('unknown object')
		return
	}

	const fromActor = await getAndCache(actorId, db)
	const targetActor = await getActorById(db, new URL(obj[originalActorIdSymbol]))
	if (targetActor === null) {
		console.warn('object actor not found')
		return
	}

	const [notifId] = await Promise.all([
		// Notify the user
		createNotification(db, 'favourite', targetActor, fromActor, obj),
		// Store the like for counting
		insertLike(db, fromActor, obj),
	])

	await sendLikeNotification(db, fromActor, targetActor, notifId, adminEmail, vapidKeys)
}
