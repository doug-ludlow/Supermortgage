# Supermortgage app — working rules

- The HTML in `docs/prototype/` is the spec for the shell; copy and structure come from it verbatim. When something is unclear, read the HTML again before deciding. `docs/SHELL-SPEC.md` decides only where the HTML is silent.
- SwiftUI only, iOS 17, no dependencies, fixtures only. Do not add a networking layer "for later".
- Small commits, one screen or component each, in the order of §5 of the spec. Each commit builds and its tests pass.
- Don't claim a screen is done until it has been compared against the HTML side by side in the simulator at 390pt, light and dark.
- Don't rename, "improve" or reword product copy. Don't add screens, settings, empty states or explanatory text the HTML doesn't have.
- Keep the fixture values exactly (§6 of the spec); tests assert them. The files in `ios/Supermortgage/Fixtures/` are transcribed from the HTML's data arrays; regenerate rather than hand-edit.
- When you must depart from the HTML (there is one sanctioned case, §5.10, the Refinance cover), say so in the commit message.
- Build and test: `xcodebuild -project ios/Supermortgage.xcodeproj -scheme Supermortgage -destination 'platform=iOS Simulator,name=iPhone 15' test` with zero warnings you introduced. `ios/project.yml` is the XcodeGen source of the project; after changing it run `xcodegen generate` in `ios/` and commit the regenerated `.xcodeproj`.
- Swift 5.10 language mode, erasable syntax only in the shell: no Swift 6 strict concurrency, no third-party packages, charts drawn with `Path`/`Canvas`.
