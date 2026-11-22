---
"@dustinedwards/site-api": minor
---

The admin entry no longer re-exports `localClient` (it stays in `./client`), `askFirst` or the types nothing imports (`Fields`, `IntentInput`, `Outcome`, `ConfirmRequest`, `PostRow`, `PostIntent`, `PostSort`, `MediaRow`, `MediaIntent`, `MediaSuggestionView`, `MentionFilter`, `MentionIntent`); `./client` no longer exports `LocalClientOptions`, `./conformance` `ConformanceCheck` and `ConformanceProbe`, `./schedules` `D1ScheduledUpdates`.
