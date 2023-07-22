import { Buffer } from 'buffer'
import {
	type ApObject,
	getApId,
	getTextContent,
	mastodonIdSymbol,
	Remote,
	sanitizeContent,
} from 'wildebeest/backend/src/activitypub/objects'
import { addPeer } from 'wildebeest/backend/src/activitypub/peers'
import { type Database } from 'wildebeest/backend/src/database'
import { MastodonId } from 'wildebeest/backend/src/types'
import { Handle } from 'wildebeest/backend/src/utils/handle'
import { generateMastodonId } from 'wildebeest/backend/src/utils/id'
import { generateUserKey } from 'wildebeest/backend/src/utils/key-ops'
import { defaultImages } from 'wildebeest/config/accounts'

const isTesting = typeof jest !== 'undefined'

export const isAdminSymbol = Symbol()

export function actorURL(domain: string, obj: { perferredUsername: string } | Pick<Handle, 'localPart'>): URL {
	if ('perferredUsername' in obj) {
		return new URL(`/ap/users/${obj.perferredUsername}`, 'https://' + domain)
	}
	return new URL(`/ap/users/${obj.localPart}`, 'https://' + domain)
}

// https://www.w3.org/TR/activitystreams-vocabulary/#actor-types
export interface Actor extends ApObject {
	type: 'Person' | 'Service' | 'Organization' | 'Group' | 'Application'
	inbox: URL
	outbox: URL
	following: URL
	followers: URL
	discoverable: boolean
	manuallyApprovesFollowers?: boolean
	alsoKnownAs?: string[]
	publicKey?: {
		id: string
		publicKeyPem: string
	}

	// Internal
	[isAdminSymbol]: boolean
	[mastodonIdSymbol]: string
}

export const PERSON = 'Person'

// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-person
export interface Person extends Actor {
	type: typeof PERSON
}

export async function fetchActor(url: string | URL): Promise<Remote<Actor>> {
	const headers = {
		accept: 'application/activity+json',
	}
	const res = await fetch(url, { headers })
	if (!res.ok) {
		throw new Error(`${url.toString()} returned: ${res.status}`)
	}

	const actor = await res.json<Remote<Actor>>()
	actor.id = new URL(actor.id)

	if (actor.summary) {
		actor.summary = await sanitizeContent(actor.summary)
		if (actor.summary.length > 500) {
			actor.summary = actor.summary.substring(0, 500)
		}
	}
	if (actor.name) {
		actor.name = await getTextContent(actor.name)
		if (actor.name.length > 30) {
			actor.name = actor.name.substring(0, 30)
		}
	}
	if (actor.preferredUsername) {
		actor.preferredUsername = await getTextContent(actor.preferredUsername)
		if (actor.preferredUsername.length > 30) {
			actor.preferredUsername = actor.preferredUsername.substring(0, 30)
		}
	}

	// This is mostly for testing where for convenience not all values
	// are provided.
	// TODO: eventually clean that to better match production.
	if (actor.inbox !== undefined) {
		actor.inbox = new URL(actor.inbox)
	}
	if (actor.following !== undefined) {
		actor.following = new URL(actor.following)
	}
	if (actor.followers !== undefined) {
		actor.followers = new URL(actor.followers)
	}
	if (actor.outbox !== undefined) {
		actor.outbox = new URL(actor.outbox)
	}

	return actor
}

// Get and cache the Actor locally
export async function getAndCache(url: URL, db: Database): Promise<Actor> {
	{
		const actor = await getActorById(db, url)
		if (actor !== null) {
			return actor
		}
	}

	const actor = await fetchActor(url)
	if (!actor.type || !actor.id) {
		throw new Error('missing fields on Actor')
	}

	const properties = actor

	const now = new Date()
	const mastodonId = await generateMastodonId(db, 'actors', now)

	const row = await db
		.prepare(
			`
INSERT INTO actors (id, type, cdate, properties, mastodon_id)
VALUES (?, ?, ?, ?, ?)
RETURNING type
    `
		)
		.bind(actor.id.toString(), actor.type, now.toISOString(), JSON.stringify(properties), mastodonId)
		.first<{
			type: Actor['type']
		}>()

	// Add peer
	await addPeer(db, getApId(actor.id).host)

	return actorFromRow({
		id: actor.id.toString(),
		type: row.type,
		pubkey: null,
		cdate: now.toISOString(),
		properties: actor,
		is_admin: null,
		mastodon_id: mastodonId,
	})
}

export async function getPersonByEmail(db: Database, email: string): Promise<Person | null> {
	const stmt = db.prepare('SELECT * FROM actors WHERE email=? AND type=?').bind(email, PERSON)
	const { results } = await stmt.all()
	if (!results || results.length === 0) {
		return null
	}
	const row: any = {
		...results[0],
		mastodon_id: results[0].mastodon_id ?? (await setMastodonId(db, results[0].id, results[0].cdate)),
	}
	return actorFromRow(row)
}

type PersonProperties = {
	name?: string
	summary?: string
	icon?: { url: string }
	image?: { url: string }
	preferredUsername?: string

	inbox?: string
	outbox?: string
	following?: string
	followers?: string
}

// Create a local user
export async function createPerson(
	domain: string,
	db: Database,
	userKEK: string,
	email: string,
	properties: PersonProperties = {},
	admin = false
): Promise<Person> {
	const userKeyPair = await generateUserKey(userKEK)

	let privkey, salt
	// Since D1 and better-sqlite3 behaviors don't exactly match, presumable
	// because Buffer support is different in Node/Worker. We have to transform
	// the values depending on the platform.
	if (isTesting || db.client === 'neon') {
		privkey = Buffer.from(userKeyPair.wrappedPrivKey)
		salt = Buffer.from(userKeyPair.salt)
	} else {
		privkey = [...new Uint8Array(userKeyPair.wrappedPrivKey)]
		salt = [...new Uint8Array(userKeyPair.salt)]
	}

	if (properties.preferredUsername === undefined) {
		const parts = email.split('@')
		properties.preferredUsername = parts[0]
	}

	if (properties.preferredUsername !== undefined && typeof properties.preferredUsername !== 'string') {
		throw new Error(
			`preferredUsername should be a string, received ${JSON.stringify(properties.preferredUsername)} instead`
		)
	}

	const id = actorURL(domain, { perferredUsername: properties.preferredUsername }).toString()

	if (properties.inbox === undefined) {
		properties.inbox = id + '/inbox'
	}

	if (properties.outbox === undefined) {
		properties.outbox = id + '/outbox'
	}

	if (properties.following === undefined) {
		properties.following = id + '/following'
	}

	if (properties.followers === undefined) {
		properties.followers = id + '/followers'
	}

	const now = new Date()
	const mastodonId = await generateMastodonId(db, 'actors', now)
	const row = await db
		.prepare(
			`
INSERT INTO actors(id, type, cdate, email, pubkey, privkey, privkey_salt, properties, is_admin, mastodon_id)
VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING *
          `
		)
		.bind(
			id,
			PERSON,
			now.toISOString(),
			email,
			userKeyPair.pubKey,
			privkey,
			salt,
			JSON.stringify(properties),
			admin ? 1 : null,
			mastodonId
		)
		.first()
	await db.prepare('INSERT INTO actor_preferences(id) VALUES(?)').bind(id).run()

	return actorFromRow(row) as Person
}

export async function updateActorProperty(db: Database, actorId: URL, key: string, value: string) {
	const { success, error } = await db
		.prepare(`UPDATE actors SET properties=${db.qb.jsonSet('properties', key, '?1')} WHERE id=?2`)
		.bind(value, actorId.toString())
		.run()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
}

export async function setActorAlias(db: Database, actorId: URL, alias: URL) {
	if (db.client === 'neon') {
		const { success, error } = await db
			.prepare(`UPDATE actors SET properties=${db.qb.jsonSet('properties', 'alsoKnownAs,0', '?1')} WHERE id=?2`)
			.bind('"' + alias.toString() + '"', actorId.toString())
			.run()
		if (!success) {
			throw new Error('SQL error: ' + error)
		}
	} else {
		const { success, error } = await db
			.prepare(
				`UPDATE actors SET properties=${db.qb.jsonSet('properties', 'alsoKnownAs', 'json_array(?1)')} WHERE id=?2`
			)
			.bind(alias.toString(), actorId.toString())
			.run()
		if (!success) {
			throw new Error('SQL error: ' + error)
		}
	}
}

export async function setMastodonId(db: Database, actorId: string | URL, cdate: string): Promise<MastodonId> {
	const mastodonId = await generateMastodonId(db, 'actors', new Date(cdate))
	const { success, error } = await db
		.prepare(`UPDATE actors SET mastodon_id = ? WHERE id = ?`)
		.bind(mastodonId, actorId.toString())
		.run()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
	return mastodonId
}

export async function getActorById(db: Database, id: Actor['id']): Promise<Actor | null> {
	const stmt = db.prepare('SELECT * FROM actors WHERE id=?').bind(id.toString())
	const { results } = await stmt.all()
	if (!results || results.length === 0) {
		return null
	}
	return actorFromRow({
		...results[0],
		mastodon_id: results[0].mastodon_id ?? (await setMastodonId(db, results[0].id, results[0].cdate)),
	})
}

export function actorFromRow(row: any): Actor {
	let properties
	if (typeof row.properties === 'object') {
		// neon uses JSONB for properties which is returned as a deserialized
		// object.
		properties = row.properties as PersonProperties
	} else {
		// D1 uses a string for JSON properties
		properties = JSON.parse(row.properties) as PersonProperties
	}

	const icon = properties.icon ?? {
		type: 'Image',
		mediaType: 'image/jpeg',
		url: new URL(defaultImages.avatar),
		id: new URL(row.id + '#icon'),
	}
	const image = properties.image ?? {
		type: 'Image',
		mediaType: 'image/jpeg',
		url: new URL(defaultImages.header),
		id: new URL(row.id + '#image'),
	}

	const preferredUsername = properties.preferredUsername
	const name = properties.name ?? preferredUsername

	let publicKey = null
	if (row.pubkey !== null) {
		publicKey = {
			id: row.id + '#main-key',
			publicKeyPem: row.pubkey,
		}
	}

	const id = new URL(row.id)

	let domain = id.hostname
	if (row.original_actor_id) {
		domain = new URL(row.original_actor_id).hostname
	}

	// Old local actors weren't created with inbox/outbox/etc properties, so add
	// them if missing.
	{
		if (properties.inbox === undefined) {
			properties.inbox = id + '/inbox'
		}

		if (properties.outbox === undefined) {
			properties.outbox = id + '/outbox'
		}

		if (properties.following === undefined) {
			properties.following = id + '/following'
		}

		if (properties.followers === undefined) {
			properties.followers = id + '/followers'
		}
	}

	return {
		type: row.type,
		id,
		url: new URL('@' + preferredUsername, 'https://' + domain),
		published: new Date(row.cdate).toISOString(),
		icon,
		image,
		summary: properties.summary ?? undefined,
		name,
		preferredUsername,

		// Actor specific
		inbox: properties.inbox,
		outbox: properties.outbox,
		following: properties.following,
		followers: properties.followers,
		discoverable: true,
		publicKey: publicKey ?? undefined,
		alsoKnownAs: properties.alsoKnownAs ?? undefined,

		// Hidden values
		[isAdminSymbol]: row.is_admin === 1,
		[mastodonIdSymbol]: row.mastodon_id,
	}
}
