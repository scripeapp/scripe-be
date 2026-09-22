# Surge Domain Rewrite

Migrate one approved Surge business capability from the legacy backend into the greenfield `surge-be/next` architecture without treating legacy code as the design authority.

## Invocation

```text
$surge-domain-rewrite <domain-name>
```

Examples:

```text
$surge-domain-rewrite inventory
$surge-domain-rewrite payments
$surge-domain-rewrite stores
```

Treat the text after the skill name as the requested domain. Normalize only for lookup; do not silently substitute a neighboring domain. If no domain is given, ask for it and do not start implementation.

## Required project context

Before implementation, require:

- `surge-be/next/rules.md`
- `surge-be/next/PROPOSED_TABLE_INVENTORY.md`
- `surge-be/next/src/domains/README.md`
- Legacy backend under `surge-be/src` and/or `surge-be/supabase`
- The project skill's rewrite workflow reference

Read `rules.md` completely. Read the relevant inventory sections, the complete domain manifest, and the rewrite workflow before acting.

## Source authority

Apply this precedence:

1. The user's current explicit instruction and approved product decisions.
2. `surge-be/next/rules.md` for engineering, security, data, and migration rules.
3. `PROPOSED_TABLE_INVENTORY.md` and `src/domains/README.md` for approved schema and domain scope.
4. Current frontend behavior for active product expectations.
5. Legacy backend code, migrations, and tests as requirements evidence only.

If authoritative sources conflict on product behavior, tenant boundaries, money semantics, inventory semantics, permissions, or data ownership, stop and request a human decision. Do not guess.

## Operating contract

For the requested domain:

1. Confirm that it is approved and identify its owning module.
2. Discover legacy behavior across routes, controllers, services, database access, migrations, tests, and relevant frontend calls.
3. Classify every discovered capability as Keep, Redesign, Merge, or Delete.
4. Write a compact implementation plan based only on approved capabilities.
5. Implement a complete vertical slice when implementation is requested.
6. Verify architecture, contracts, authorization, database behavior, migrations, and tests.
7. Report implemented behavior, intentional omissions, decisions, and risks.

Keep the slice narrow. Do not expand into adjacent domains merely because legacy code mixed them together.

## Non-negotiable constraints

- Never import from or edit the legacy backend as part of the rewrite.
- Never port Supabase packages, APIs, environment variables, storage paths, or authorization assumptions.
- Never mechanically translate a legacy query or migration.
- Never invent a table, endpoint, event, role, permission, or provider behavior merely to make the module look complete.
- Never add compatibility facades, dual writes, or placeholder endpoints.
- Never register an empty router.
- Never use `any` at an HTTP, domain, repository, integration, or event boundary.
- Never use floating-point values for money.
- Never expose provider payloads as the stable domain/API contract.
- Preserve unrelated user changes in a dirty worktree.

## Required architecture

A completed backend slice normally owns:

```text
<domain>.repository.ts
<domain>.service.ts
<domain>.controller.ts
<domain>.routes.ts
<domain>.schemas.ts
<domain>.types.ts
```

Maintain this dependency direction:

```text
routes -> controller -> service -> repository -> DatabaseContext
                         \\-> domain types and Zod contracts
```

Repositories accept `DatabaseContext`; controllers execute no SQL; services own workflows and transaction boundaries; provider integrations live behind adapters in `src/integrations`.

## Completion standard

Do not call a domain complete because files compile. A rewritten domain is done only when its approved behavior works through the new HTTP and database path, authorization and tenant isolation are enforced, relevant migrations and tests pass against real PostgreSQL, and no retained frontend path accesses Supabase directly.

Finish with a report covering:

- Scope and owning module
- Keep/Redesign/Merge/Delete decisions
- Implemented schema, API, authorization, and workflows
- Tests and verification commands
- Intentional omissions and downstream dependencies
- Remaining risks
