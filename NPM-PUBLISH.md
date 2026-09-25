# Publish @omnihilbras/hilbras to npm

Run these yourself in a terminal. I cannot: npm is not authenticated here
(401), and I will not handle your npm credentials or OTP.

## 1. Log in (interactive, opens a browser)

    npm login

Use the account that should own the package. If the `@omnihilbras` scope does
not exist on npm yet, npm will ask you to create that org, or you can publish as
its first member. A free account can publish public scoped packages, but the
scope has to exist first: https://www.npmjs.com/org/create

## 2. Confirm who you are

    npm whoami

## 3. Publish from the SDK directory

    cd packages/omnihilbras-sdk
    npm publish --access public

`prepublishOnly` rebuilds the SDK first, so the tarball always matches source.
If your account has 2FA enabled, npm asks for a one-time password
(`npm token create` also works with a token + `npm otp`).

## 4. Verify

    npm view @omnihilbras/hilbras version
    npm view @omnihilbras/hilbras dist-tags

    # in a scratch project
    npm i @omnihilbras/hilbras
    node -e "import('@omnihilbras/hilbras').then(m => console.log(Object.keys(m).length, 'exports'))"

## If a name problem comes up

`@omnihilbras/hilbras` and the unscoped `omnihilbras-sdk` were both confirmed
free at the time of release. npm names cannot be reused once published, so if
`npm publish` complains about the scope, stop and pick one before retrying:

- keep `@omnihilbras/hilbras` and create the npm org, or
- switch the name in `packages/omnihilbras-sdk/package.json` (and the
  `workspace:*` dependency in `apps/gateway/package.json`) to `omnihilbras-sdk`.
