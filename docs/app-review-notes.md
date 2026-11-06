# App review notes (Apple and Google)

Reviewers must be able to sign in, and they must never see real families. The
portal has two sealed reviewer accounts for this. An administrator creates them
from **Admin > Integrations > App store reviewer accounts**. Passwords are
generated on the spot and shown once, so copy them straight into the store
console. Clicking the button again resets both passwords and the sample data.

The accounts live in a separate sample world (`is_demo` rows plus the
`demo_isolation` restrictive policies). They see a sample class, posts, an
event, and messages. They cannot see, message, or be seen by real members.

## App Store Connect: App Review Information

- **Sign-in required:** yes
- **User name / Password:** the demo parent (use the demo teacher if the
  reviewer asks to see teacher tools)
- **Notes:**

> Veritas Village Family Portal is the private members' portal for Veritas
> Village, a registered 501(c)(3) homeschool co-op. Accounts are by invitation
> only, so there is no public sign-up. The attached demo account is a sample
> parent with made-up content. It cannot see any real family's information.
> To see the main features: Home (posts and events), Messages (a sample
> conversation and a class channel), Photos (the shared library), and Account
> Settings (notification preferences and "Delete account"). Push
> notifications can be turned on from Account Settings > Phone &
> notifications. Support: https://family.veritasvillage.org/support. Privacy
> policy: https://family.veritasvillage.org/privacy.

## Google Play Console: App access

Choose "All or some functionality is restricted", then add an instruction set:

- **Name:** Reviewer sign-in
- **Username / password:** the demo parent
- **Any other instructions:** use the Notes text above.

## Account deletion

Apple requires in-app deletion and Google requires a web link. In-app:
Account Settings > Delete account. Web: https://family.veritasvillage.org/delete-account.
If a reviewer deletes the demo account, create it again from the admin card.

## After approval

Remove the accounts from the same admin card if you want them gone, or leave
them in place for future review rounds.
