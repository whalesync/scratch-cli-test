# Runbook: Apple Developer Setup for Code Signing an Electron App

This guide walks through everything you need to do **on Apple's side** to get an Electron app code signed and notarized for macOS distribution. It assumes you already have an Apple Developer account and a Mac to work from.

By the end of this guide you'll have:

- **Current Apple intermediate certificates** (Developer Authentication, Developer ID G1, Developer ID G2) in your **login** keychain
- A **Developer ID Application certificate** installed in your Keychain
- A **`.p12` export** of that certificate for use in CI/CD
- Your **Team ID**
- Either an **app-specific password** or an **App Store Connect API key** for notarization

**Where to keep everything:** Store passwords, key files, and related material generated in this runbook (for example the `.p12` and its export password, app-specific password, App Store Connect API key / `.p8`, Team ID, and any notes you need to rotate or audit) in **1Password**, in the secure note **Apple Developer ID Certificate**. That item is the team’s canonical place for this material; copy from there into CI or other systems as needed—do not rely on chat, email, or the repo for long-term storage.

---

## 1. Confirm your Developer Program enrollment is active

Before doing anything else, sign in to [developer.apple.com/account](https://developer.apple.com/account) and confirm your membership status reads **Active**.

A few things to know:

- New individual accounts usually activate within a day after payment.
- Organization accounts need a D-U-N-S number and can take several days to a couple of weeks while Apple verifies your business.
- Until enrollment is complete, the **Certificates** section will be empty or locked, and you won't be able to generate the certificate you need.

---

## 2. Install up-to-date Apple intermediate certificates in your login keychain

Code signing and verification for Developer ID use an **intermediate** certificate chain. Missing, expired, or stale intermediates in your keychain can cause `codesign` or validation issues. **Before** you create or work with a Developer ID Application certificate, ensure the relevant Apple intermediates are current and live in the **login** keychain (not only System).

1. Open **[Apple PKI / Certificate Authority](https://www.apple.com/certificateauthority/)** and go to the **Apple Intermediate Certificates** table.
2. Download at least these **`.cer`** files (the page lists the exact file names and expiry dates):
   - **Developer Authentication** (file `DevAuthCA.cer` on the PKI page)
   - **Developer ID - G1** (Developer ID — file `DeveloperIDCA.cer`; Apple lists an expiry in the link text)
   - **Developer ID - G2** (file `DeveloperIDG2.cer`)
3. **Double-click** each downloaded `.cer` file; when Keychain Access asks, add it to the **login** keychain.
4. In **Keychain Access** → **login** → **Certificates** (or search by name), confirm all three are present. If you replace a Mac, reinstall the same files from the PKI page. **Re-check this page** when you hit odd signing or notarization errors or after a major macOS update—Apple occasionally publishes updated intermediates.

**CI note:** The macOS host that runs `codesign` (including CI runners) should have the same intermediates available; install them in the keychain the build uses, or follow your platform’s pattern for the signing environment.

---

## 3. Choose your distribution path

This decision determines which certificate(s) you'll create.

| Distribution method                             | Certificate(s) needed                                     |
| ----------------------------------------------- | --------------------------------------------------------- |
| Your website, GitHub Releases, direct downloads | **Developer ID Application**                              |
| Mac App Store                                   | **Mac App Distribution** + **Mac Installer Distribution** |

Most Electron apps are distributed outside the App Store because the App Store sandbox imposes restrictions that conflict with how many Electron apps work (file system access, child processes, native modules, etc.).

**This guide focuses on the Developer ID path.** If you're targeting the Mac App Store, the certificate types differ but the overall flow is the same.

---

## 4. Generate a Certificate Signing Request (CSR)

The CSR is a file that proves you control a private key, paired with a public key that Apple will sign. You generate it locally on your Mac.

### Steps

1. Open **Keychain Access** (in `/Applications/Utilities/` or via Spotlight).
2. From the menu bar: **Keychain Access → Certificate Assistant → Request a Certificate from a Certificate Authority…**
3. Fill in the form:
   - **User Email Address**: any email — Apple ignores this field. Using your developer account email keeps things tidy.
   - **Common Name**: any string — Apple replaces it on the issued certificate. Use your name or company name so the private key is recognizable in Keychain.
   - **CA Email Address**: leave **blank**.
   - **Request is**: select **Saved to disk**.
4. Click **Continue** and save the `.certSigningRequest` file somewhere you can find it.

### Why the CSR field values don't matter

The CSR is just a vehicle for your public key. When Apple issues your Developer ID Application certificate, it overwrites the fields:

- **Common Name** becomes `Developer ID Application: <Your Name or Org> (TEAMID)`, pulled from your Developer Program enrollment.
- **Email** is dropped entirely from the issued certificate.

So the values are cosmetic — they only affect how the **private key** is labeled in your local Keychain. They do not need to match your Apple ID.

### Common pitfall

If you accidentally pick **Emailed to the CA** instead of **Saved to disk**, Keychain tries to email Apple directly and the flow silently breaks. Always use Saved to disk.

---

## 5. Create the certificate on Apple's developer portal

_NOTE: Creating the Developer ID certificate must be done by the Curtis as he is the account holder._

1. Go to [developer.apple.com/account](https://developer.apple.com/account) → **Certificates, Identifiers & Profiles** → **Certificates**.
2. Click the **+** button.
3. Under **Software**, choose **Developer ID Application**, then **Continue**.
4. Upload the `.certSigningRequest` file from step 4.
5. Click **Continue**, then **Download** the resulting `developerID_application.cer` file.
6. **Double-click the `.cer` file** to install it into your login Keychain.

To verify it installed: open Keychain Access, select the **login** keychain and **My Certificates** category. You should see an entry named `Developer ID Application: <Your Name> (TEAMID)` with a disclosure triangle that expands to reveal the matching private key.

> **Important:** The certificate is only useful if it's paired with the private key. The private key was created on your Mac when you generated the CSR. If you switch to a different Mac, you'll need to either re-do this whole process there or import the `.p12` from step 6.

---

## 6. Export the certificate as a `.p12`

You'll need a `.p12` file (a bundled certificate + private key) to sign builds in CI/CD or on other machines.

1. In Keychain Access, find your `Developer ID Application: …` certificate under **login → My Certificates**.
2. **Right-click** the certificate (not the private key inside it) → **Export "Developer ID Application: …"**.
3. Choose **Personal Information Exchange (.p12)** as the file format.
4. Save it somewhere safe (not in your repo — this file is a credential). **Record the file and its password in 1Password** (secure note **Apple Developer ID Certificate**).
5. Set a strong password when prompted. **You'll need this password later** as `CSC_KEY_PASSWORD` in your build environment. **Save the password in that same 1Password secure note.**

For CI/CD, you'll typically base64-encode the `.p12` and store it as a secret:

```bash
base64 -i developer-id.p12 | pbcopy
```

Then paste it into your CI provider's secret store (GitHub Actions secret, etc.). **Also keep a copy of the base64 value (or a pointer to the `.p12` backup) in 1Password** under **Apple Developer ID Certificate** so the team can recover or re-paste without hunting through CI alone.

---

## 7. Find your Team ID

Your Team ID is a 10-character alphanumeric string (e.g., `AB12CD34EF`) that identifies your developer team to Apple's tooling.

1. Go to [developer.apple.com/account](https://developer.apple.com/account).
2. Click **Membership details** in the sidebar.
3. Copy the **Team ID** value. **Store it in 1Password** (secure note **Apple Developer ID Certificate**) if it is not already there.

You'll pass this to the notarization tooling as `APPLE_TEAM_ID` (or `teamId` in config).

---

## 8. Set up notarization credentials

Notarization is the second step after signing — Apple runs an automated malware scan on your signed app and issues a ticket that Gatekeeper trusts. You need credentials so the build tooling can submit your app to Apple's notary service.

You have two options. Pick one.

### Option A: App-specific password (simpler)

Good for: getting started, signing locally, small teams.

1. Sign in to [appleid.apple.com](https://appleid.apple.com).
2. Go to **Sign-In and Security → App-Specific Passwords**.
3. Click **+** (or **Generate an app-specific password**).
4. Give it a label like `Electron notarization`.
5. Save the generated password somewhere safe — Apple shows it once. **Add it to 1Password** (secure note **Apple Developer ID Certificate**).

You'll use:

- `APPLE_ID` — your Apple Developer account email
- `APPLE_APP_SPECIFIC_PASSWORD` — the password you just generated
- `APPLE_TEAM_ID` — from step 7

> **Note:** App-specific passwords are tied to your Apple ID password. If you change your Apple ID password, the app-specific password is revoked and you'll need to generate a new one.

### Option B: App Store Connect API key (better for CI)

Good for: production CI/CD, teams, anyone who wants credentials that aren't tied to a personal Apple ID.

1. Sign in to [App Store Connect](https://appstoreconnect.apple.com).
2. Go to **Users and Access → Integrations → Team Keys** (older UI: **Keys**).
3. Click **+** to generate a new key.
4. Give it a name and assign a role of **Developer** or **App Manager**.
5. Click **Generate**.
6. Note the **Issuer ID** (a UUID) and **Key ID** (10-character string) shown on the page.
7. **Download the `.p8` private key file.** You can only download it once — if you lose it, you'll need to revoke the key and create a new one. **Store the `.p8` (or a safe backup), Issuer ID, and Key ID in 1Password** (secure note **Apple Developer ID Certificate**).

You'll use:

- `APPLE_API_KEY` — absolute path to the `.p8` file
- `APPLE_API_KEY_ID` — the 10-character Key ID
- `APPLE_API_ISSUER` — the Issuer ID UUID

---

## 9. Quick checklist before you build

By this point you should have all of the following:

- [ ] Active Apple Developer Program membership
- [ ] **Developer Authentication**, **Developer ID - G1**, and **Developer ID - G2** intermediates installed and current in the **login** keychain (see **§2**; [Apple PKI](https://www.apple.com/certificateauthority/))
- [ ] `Developer ID Application` certificate installed in your login Keychain (with private key visible underneath it)
- [ ] `.p12` file exported, with its password saved and **recorded in 1Password** (secure note **Apple Developer ID Certificate**)
- [ ] Team ID copied (and in that **1Password** secure note)
- [ ] Either an app-specific password **or** a `.p8` API key with Issuer ID and Key ID, **stored in 1Password** (same secure note)
- [ ] Xcode Command Line Tools installed (`xcode-select --install`) — required for `codesign` and `notarytool`

If all of those are checked, you're ready to configure your Electron build tool (electron-builder or Electron Forge) to sign and notarize.

---

## Reference: what each credential is used for

| Credential                                         | Purpose                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------- |
| Apple intermediate certs (DevAuth, Dev ID G1, G2)  | Complete the trust chain in Keychain for Developer ID and related signing  |
| Developer ID Application certificate (in Keychain) | Signs the `.app` bundle with `codesign`                                   |
| `.p12` export                                      | Same certificate, portable to other machines / CI                         |
| `.p12` password (`CSC_KEY_PASSWORD`)               | Unlocks the `.p12` during CI builds                                       |
| Team ID                                            | Identifies your team to `notarytool` and embedded in the certificate's CN |
| App-specific password **or** API key               | Authenticates to Apple's notary service for notarization                  |

---

## Renewals and gotchas

- **Apple’s intermediate CA certificates** can be rotated or replaced; if signing or notarization starts failing after a long period of stability, re-download **Developer Authentication**, **Developer ID - G1**, and **Developer ID - G2** from [Apple PKI](https://www.apple.com/certificateauthority/) and install into **login** again.
- **Developer ID Application certificates are valid for 5 years.** Apps signed with the certificate continue to work after the cert expires (the signature timestamp is what matters), but you can't sign _new_ builds with an expired cert.
- **Apple Developer Program membership is annual.** If it lapses, your certificates are revoked and existing notarized builds may eventually stop passing Gatekeeper checks for new downloads.
- **You can have multiple Developer ID Application certificates** active at once (Apple allows up to a small limit). This is useful for rotating to a new cert before the old one expires.
- **Don't commit the `.p12` or `.p8` to git.** Treat them like passwords. Use your CI provider's secret storage for build-time access, and **keep the authoritative copy of secrets and key material in 1Password** (secure note **Apple Developer ID Certificate**).
- **Keep a backup of the `.p12` and its password in that 1Password secure note** (and anywhere else your policy requires). If you lose the private key, you cannot recover it — you'd have to revoke the certificate and start over.
