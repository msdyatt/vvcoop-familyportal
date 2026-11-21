# Staging Environment

A separate hosted staging environment for the Veritas Village co-op portal, built on Cloudflare Workers and Supabase. Staging is for internal testing only — production remains untouched.

## Architecture

| Component | Production | Staging |
|-----------|------------|---------|
| URL | veritasvillage.org | staging.veritasvillage.org |
| Cloudflare Worker | veritas-village | veritas-village-staging |
| Supabase project | jtwemgyhxylbhjzxgyvh | *(to be created)* |
| Seed data | Real | Fake only |

## Staging Cloudflare Worker

The staging worker deploys from the `dist/server/index.js` output and the generated `dist/server/wrangler.json`. It differs from production in two ways:

- Worker name: `veritas-village-staging` (vs `veritas-village`)
- Cloudflare Custom Domain: `staging.veritasvillage.org` (vs `veritasvillage.org`)

The custom domain is attached via Cloudflare's Custom Domain feature, which manages certificate lifecycle. The domain must be pointed at the same Cloudflare account as production, or be on the shared Cloudflare Free plan.

## Staging Supabase Project

A separate Supabase project is created for staging. Key configuration:

- **Auth redirect URLs**: Must include `staging.veritasvillage.org` for magic link and OAuth callbacks. The production project does NOT list the staging domain.
- **Allowed hosts**: Must include `staging.veritasvillage.org` for email verification.
- **Email link URLs**: Configure Supabase Auth to send links to `staging.veritasvillage.org` instead of production.
- **Service role key**: Used for seeding fake data; stored as a staging GitHub secret.
- **Anon key**: Used by the staging worker; stored as a staging GitHub secret.

## Seed Data

The staging database is seeded with fake data via `npm run seed:staging` in the staging CI workflow. The seed script (`scripts/seed-staging.mjs`) creates:

- One school year (2026-27)
- Three families: The Smiths (two parents, two children), The Johnsons (one parent, one child), The Garcias (not returning)
- Five children total, ages 2-7, enrolled in appropriate age-based classes
- One teacher
- Eleven classes (ages 2-8) plus one high school elective
- Enrollment requests, teacher assignments, document submissions, dues statuses, and one event
- An active enrollment period

The seed script is idempotent and can be re-run.

## Staging CI Workflow

The staging workflow (`.github/workflows/staging.yml`) runs on every pull request targeting `main`. It:

1. Builds, lints, typechecks, and tests the application
2. Deploys the staging Cloudflare Worker
3. Deploys Supabase edge functions to the staging project
4. Runs Supabase migrations against the staging project
5. Seeds the staging database with fake data

The workflow is guarded by a GitHub Actions environment named `Staging`, which supports required reviewers and approval gates.

## Required GitHub Secrets

The staging environment requires the following secrets:

| Secret Name | Description |
|-------------|-------------|
| `SUPABASE_STAGING_ACCESS_TOKEN` | Service role key for the staging Supabase project |
| `SUPABASE_STAGING_PROJECT_REF` | Project reference (id) for the staging Supabase project |
| `SUPABASE_STAGING_DB_PASSWORD` | Database password for the staging Supabase project (used by `supabase db push`) |

Cloudflare secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) are shared with production and do not need staging-specific versions.

## Setup Steps

1. Create a new Supabase project in your account.
2. Configure Auth redirect URLs and allowed hosts for `staging.veritasvillage.org`.
3. Add the three staging secrets listed above to the Staging GitHub environment.
4. Create a GitHub Actions environment named `Staging` in the repository settings.
5. Create the Cloudflare Custom Domain for `staging.veritasvillage.org` and attach it to the staging worker.
6. Open a pull request targeting `main` to trigger the staging workflow.

## Rollback

- **Supabase migrations**: Run `supabase db reset` against the staging project to drop and recreate the database. Re-run the seed script after a reset.
- **Worker deployment**: Deploy a previous version by checking out an earlier commit and re-running the deployment step.
- **Seed data**: Run the seed script again to overwrite existing data.

## Verification

After deployment:

1. Visit `staging.veritasvillage.org` and verify the application loads.
2. Log in with a seeded family account (email: check Supabase Auth users for the seeded passwords).
3. Verify that the enrollment period is active and classes are listed.
4. Verify that fake data is present (children, enrollments, requirements, events).

## Production Isolation Checklist

- [ ] Staging worker name differs from production
- [ ] Staging Supabase project is separate from production
- [ ] Staging seed data is fake (no real family names or info)
- [ ] Staging CI workflow does not deploy to production
- [ ] Staging secrets are distinct from production secrets
- [ ] Custom domain for staging does not affect production DNS