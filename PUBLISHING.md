# Publishing a release

This repository publishes releases from tag pushes or from **Actions → Publish release → Run workflow**. It doesn't add plugin update checking or signed updates.

For 1.0.0, copy this kit's contents into your existing `perishxd/dms-manager` checkout. Copy the `.github` directory too. Don't put the whole release kit inside `src/userplugins`; only the `DMsManager` folder belongs there.

From your repository folder in PowerShell:

```powershell
git status
git add .
git commit -m "Release 1.0.0"
git push origin main
git tag v1.0.0
git push origin v1.0.0
```

Pushing the tag starts **Actions → Publish release**. Once it finishes, **Releases → DMs Manager 1.0.0** will contain `DMsManager-1.0.0.zip` and the release notes.

If the tag already exists but no workflow ran, push the updated workflow to the default branch first. Then open **Actions → Publish release → Run workflow**, leave the branch as **main**, and enter the existing tag `v1.0.0`. The workflow checks out and packages that tag without moving it. To check whether it exists remotely, run `git ls-remote origin refs/tags/v1.0.0`. If it prints nothing and your local tag exists, run `git push origin v1.0.0`.

For future releases, update `DMsManager/version.ts`, both READMEs, and `RELEASE_NOTES.md`, then commit, push, and tag the new version. The packaging step rejects tags that don't match the version file and notes.

Don't reuse an existing version tag. If Git says `v1.0.0` already exists, inspect the existing tag and release before publishing anything else.

The checkout step uses GitHub's repository token and supports public and private repositories. A private repository's release is accessible only to people with repository access. It packages the tagged source; local verification should be completed before tagging.
