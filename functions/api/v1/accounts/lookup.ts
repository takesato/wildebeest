// https://docs.joinmastodon.org/methods/accounts/#lookup

import { getAccount } from 'wildebeest/backend/src/accounts/getAccount'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { resourceNotFound } from 'wildebeest/backend/src/errors'
import { ContextData } from 'wildebeest/backend/src/types/context'
import { cors } from 'wildebeest/backend/src/utils/cors'
import { Env } from 'wildebeest/consumer/src'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

type Dependency = { domain: string; db: Database }

export const onRequestGet: PagesFunction<Env, '', ContextData> = async ({ request, env }) => {
	const url = new URL(request.url)

	const acct = url.searchParams.get('acct')
	if (acct === null || acct === '') {
		return resourceNotFound('acct', '')
	}
	return handleRequest({ domain: url.hostname, db: await getDatabase(env) }, acct)
}

export async function handleRequest({ domain, db }: Dependency, acct: string): Promise<Response> {
	const account = await getAccount(domain, db, acct)
	if (account === null) {
		return resourceNotFound('acct', acct)
	}
	return new Response(JSON.stringify(account), { headers })
}