# Server

- `LocalStore.deleteAll()` and its server counterpart clear buffered key/value writes only, not tables written with raw `sql.exec`. `resetWorld` in `GameServer` drops the `chat` table by name for that reason.
- `ClientBundle.stored()` (`server/clientBundle.ts`) orders build ids by write time. They are commit shas, so an alphabetical sort would make `collectGarbage` delete arbitrary builds, including one about to be activated.
- `World.drain` (`server/world.ts`) closes every socket with code 1012 before exit, because Bun exits without sending close frames (oven-sh/bun#25722) and clients would otherwise wait for their own timeout.
- `POST /api/account` (`server/api.ts`) catches Better Auth's `APIError` and returns `status(400, …)`. `APIError.status` is a name such as `"UNPROCESSABLE_ENTITY"`, which Elysia cannot read, so uncaught it reaches the browser as a 200.
- `MIN_PASSWORD_LENGTH` (`app/lib/account.ts`) is a length floor only. An account's email is stored and nothing is sent to it, so there is no password reset.

## Wire

- `parseServerMessage` uses valibot `v.object` schemas, which strip unknown fields. A field added to a message type but not to its schema is dropped in transit without a type error.
- The Eden client in `app/lib/api.ts` is built from `window.location.origin`, not `host`. Eden prefixes a non-loopback bare host with `https://`, which breaks a phone on a LAN dev server over plain HTTP.
