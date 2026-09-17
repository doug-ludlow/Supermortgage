# Supermortgage app

The Supermortgage iPhone app. This repository holds Milestone 1, **the shell**: every screen, tab, sheet and interaction of the agent prototype rebuilt natively in SwiftUI, running entirely on fixture data with no network, no persistence and no dependencies.

The specification is the clickable prototype at `docs/prototype/Supermortgage-Agent-Prototype.html`; the build brief is `docs/SHELL-SPEC.md`. Where the two disagree, the HTML wins.

## Open, run, walk

Requires Xcode 16 (iOS 17 SDK, an iPhone 15 simulator). No other tooling is needed; the project file is committed.

```sh
open ios/Supermortgage.xcodeproj
xcodebuild -project ios/Supermortgage.xcodeproj -scheme Supermortgage -destination 'platform=iOS Simulator,name=iPhone 15' build
xcodebuild -project ios/Supermortgage.xcodeproj -scheme Supermortgage -destination 'platform=iOS Simulator,name=iPhone 15' test
```

The first command opens the project (press ⌘R to run on the iPhone 15 simulator). The second builds it from the command line. The third runs the unit tests (`SupermortgageTests`) and the walk (`SupermortgageUITests`, one test that taps through the whole product in the order of §8 of the spec).

To run only the walk:

```sh
xcodebuild -project ios/Supermortgage.xcodeproj -scheme Supermortgage -destination 'platform=iOS Simulator,name=iPhone 15' test -only-testing:SupermortgageUITests
```

## Layout

```
docs/prototype/   the HTML prototype, copied in unchanged — the spec
docs/SHELL-SPEC.md the build brief for this milestone
ios/project.yml   XcodeGen spec (regenerate with `xcodegen generate` from ios/)
ios/Supermortgage.xcodeproj   committed so the project opens without tooling
ios/Supermortgage/            the app target: App, DesignSystem, Features, Fixtures, Resources
ios/SupermortgageTests/       unit tests: fixtures, the number, work transitions, the chat script
ios/SupermortgageUITests/     the walk
api/  web/                    placeholders for later milestones
```

## What it is not

Milestone 1 has no agent runtime, no API, no real connections (Plaid, servicer, credit), no push, no Sign in with Apple and no full refinance application. Every vendor is a fixture. Nothing is persisted between launches; the app opens on Welcome every time.

Fictional data only.
