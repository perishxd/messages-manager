# Publishing Messages Manager

Copy this kit into the root of the existing messages-manager checkout, including .github and tools. Remove the old tracked DMsManager folder and Install-DMsManager scripts from the checkout so both versions are not shipped.

Run `python tools/package_release.py 1.1.0 MessagesManager-1.1.0.zip` to verify packaging locally. Keep the generated ZIP out of the source commit. Review and push the source changes, then tag the release commit. The Publish release workflow packages the tagged source and attaches the install ZIP.

For a new version, update MessagesManager/version.ts, both READMEs, and RELEASE_NOTES.md before tagging. Use a new version if the existing tag has already been published.
