# Checking a signed document's timestamp

Every sealed document in Family Village is stamped by an independent
time-stamping authority (DigiCert by default). This note says what that proves,
what it does not, and how to check it yourself with OpenSSL, with nothing from
the portal involved.

## What it proves

A time-stamping authority is a third party that signs "I saw this exact
SHA-256 value at this moment." The format is RFC 3161. If the value matches a
file today, that file existed, byte for byte, at that time. Neither the co-op nor
the portal can move that date earlier or later.

## What it does not prove

- Who signed. That comes from the audit trail (signed-in account, second factor,
  IP address, browser), which is recorded by the portal and printed on the
  certificate page. The timestamp says nothing about identity.
- It is not a PAdES or other certificate-based digital signature embedded in the
  PDF. A PDF reader will not show a green "signed" banner.
- It does not make a signature legally sufficient for any particular purpose.
  Whether a parent's electronic signature is enough for a liability waiver that
  involves a minor is a question for the co-op's attorney.

## The two timestamps and the files

For each sealed request the private bucket holds, under `sign/requests/<request id>/`:

| File | What it is |
| --- | --- |
| `sealed.pdf` | The signed document with the certificate page at the end. This is what families download. |
| `signed-content.pdf` | The original pages with every entry placed on them, without the certificate page. |
| `content-timestamp.tsr` | Timestamp over the SHA-256 of `signed-content.pdf`. Its details are printed on the certificate page. |
| `sealed-timestamp.tsr` | Timestamp over the SHA-256 of `sealed.pdf`. Best effort: if the authority did not answer the second time, this file is absent and the audit trail says so. |

Why two: the certificate page shows the first timestamp, so the first one cannot
cover the page it is printed on. It covers everything before that page. The
second covers the finished file, certificate included.

The original upload's hash and the signed content's hash are both printed on the
certificate page. The signed-in administrator can download all four files from
Admin, Documents.

## Checking with OpenSSL

You need OpenSSL 1.1 or later (the LibreSSL that ships with macOS has an older
`ts` command; `brew install openssl` gives a current one) and the authority's
root certificate in a file. DigiCert's chain is in most operating systems' trust
stores. On macOS with Homebrew the bundle is at
`/opt/homebrew/etc/openssl@3/cert.pem`.

1. Pull the authority's certificates out of the reply. The authority includes
   them, so no download is needed:

   ```bash
   openssl ts -reply -in content-timestamp.tsr -token_out -out token.der
   openssl pkcs7 -inform DER -in token.der -print_certs -out tsa-certs.pem
   ```

2. Verify the timestamp against the file it covers:

   ```bash
   openssl ts -verify -data signed-content.pdf -in content-timestamp.tsr \
     -CAfile /path/to/ca-bundle.pem -untrusted tsa-certs.pem
   ```

   Success prints `Verification: OK`. A line saying the responder certificate
   "is not a CA cert" is normal and harmless. If the file has been changed by a
   single byte the command fails with `message imprint mismatch`.

3. To read the time and serial number the authority recorded:

   ```bash
   openssl ts -reply -in content-timestamp.tsr -text
   ```

   Compare the "Message data" bytes with `shasum -a 256 signed-content.pdf`, and
   the serial number and time with the certificate page.

4. Do the same for `sealed-timestamp.tsr` and `sealed.pdf` if you want to check
   the whole file.

If you have no CA bundle, DigiCert publishes its roots at
https://www.digicert.com/kb/digicert-root-certificates.htm. Use the
"DigiCert Trusted Root G4" file as `-CAfile`.

## Changing the authority

The edge function `esign-seal` reads the secret `TIMESTAMP_AUTHORITY_URL`.
Unset, it uses `http://timestamp.digicert.com`. Another authority works the same
way, for example Sectigo at `https://timestamp.sectigo.com`. Set it to the word
`disabled` to seal without an independent timestamp; the certificate page then
says none is attached.

```bash
supabase secrets set TIMESTAMP_AUTHORITY_URL=https://timestamp.sectigo.com --project-ref jtwemgyhxylbhjzxgyvh
```

If the authority is configured and does not answer, sealing stops, the signatures
stay safe in the database, and an administrator can press "Try sealing again" in
Admin, Documents. The portal checks that the reply is for the right hash and
answers its own request; it does not check the authority's signature itself,
which is what the OpenSSL command above does.
