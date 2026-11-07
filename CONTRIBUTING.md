# Contributing to Hive Code

Thank you for helping. Bug reports, fixes and improvements to the docs are all welcome.

## Reporting a bug

Open an issue with what you did, what you expected and what happened. Add the relevant part of `company doctor` output (it includes the versions), after checking it for secrets. For security problems, follow [SECURITY.md](SECURITY.md) instead.

## Before a large change

Open an issue first and describe the problem and the change you have in mind. It saves both of us time if the direction needs adjusting.

## Development setup

You need Node 22.18 or newer. For the app you also need Flutter (the version in `packages/app/pubspec.yaml`) and `clang`.

```sh
git clone https://github.com/hivecode-app/hive-code.git
cd hive-code
npm ci
```

| What | Command |
|---|---|
| Type check | `npm run typecheck` |
| Tests | `npm test` |
| Contract check (the starter company and the fixtures) | `npm run check:contract` |
| Installer and deploy scripts | `npm run test:deploy` |
| App analysis | `cd packages/app && flutter analyze` |
| App tests | `cd packages/app && flutter test` |

The app's screen tests are golden tests. If you change a screen on purpose, update its images with `flutter test --update-goldens <test file>` and look at every changed image before you commit.

[Architecture](docs/architecture.md) explains how the packages fit together.

## Pull requests

- One change per pull request, with a title that says what changes for the user.
- Add or update tests for what you change.
- CI must be green: the type check, the tests, the contract check, and for the app `flutter analyze` and `flutter test`.
- Every pull request gets a review before it merges.
- Text that users see goes in both `packages/app/lib/l10n/app_en.arb` and `app_he.arb`. Keep it short and plain, and keep error messages to one sentence: what happened and what to do.

## Code style

- TypeScript runs directly on Node (`--experimental-strip-types`), without a build step in development. Keep dependencies to a minimum.
- Write comments that explain why, not what.
- Match the style of the code around your change.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
