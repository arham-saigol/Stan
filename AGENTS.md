# Stan

Stan is a private, always-on WhatsApp agent that helps Arham grow his X account. It finds worthwhile conversations, drafts original posts and replies, schedules or publishes authorized content, monitors engagement, and uses analytics to improve future decisions. Stan should reduce the effort required from Arham without taking control away from him.

Stan runs as a persistent local daemon and is operated through the `stan` CLI. WhatsApp is its primary interface, Flue provides durable agent sessions and scheduling, Pi provides Codex authentication and model access, Zernio handles authenticated X actions and analytics, XQuik handles public X research, and Firecrawl handles wider web research. Skills should expose only the instructions and tools relevant to the current task.

Because Stan can send proactive messages, maintain long-term memory, run unattended jobs, and modify public content, correctness includes strict owner authorization, exact approval boundaries, durable scheduling, idempotent publishing, scoped filesystem access, secret protection, reliable recovery, and honest reporting of provider results. Stan must remain useful without becoming intrusive, preserve continuity across restarts, and never claim an external action succeeded until it has been verified.

## The lazy senior

I want ambitious products built from simple systems and software that feels obvious. Work like a lazy senior engineer who combines “measure twice, cut once” with YAGNI: rigorous about understanding, restrained about implementation. Lazy means efficient, not careless. The best code is code we never have to own.

Trace the real flow, callers, boundaries, and failure modes before choosing a fix. A small diff in the wrong place is a second bug. Fix the root cause at the narrowest shared boundary.

For a consequential design choice, inspect local precedents and dependencies, then current official documentation and proven patterns in established products. Know the constraint, the invariant, and why a simpler alternative does not hold. Research in proportion to the decision.

Treat these instructions as strong defaults. The user’s explicit intent and the reality of the problem take precedence.

## Spend the complexity budget

Climb this ladder in order:

1. Remove the need or reduce the requirement.
2. Reuse a capability already present when it solves the problem cleanly.
3. Use the language, browser, framework, or platform primitive.
4. Use an established, well-maintained library.
5. Only then write the smallest custom implementation that fully solves the problem.

Check the installed version’s documentation and types before judging a dependency. Prefer an existing dependency when it fits. Add a package when it removes more code and operational risk than it adds; weigh maintenance, adoption, security, API stability, and transitive cost. Use established libraries for solved, non-domain problems, with only the boundary code the application genuinely needs. Custom code is for the remaining project-specific gap.

Every new line is a liability. Prefer deletion, consolidation, boring control flow, good defaults, and one obvious path. Let abstractions emerge from stable repetition; predicted reuse is not reuse. Flexibility, configuration, fallbacks, and compatibility need a present product requirement.

Smallest means the least system we can maintain, not the fewest characters. Preserve trust-boundary validation, accessibility, type safety, security, and error handling that prevents corrupt or lost data.

## Build for the boring future

A fix should remain the right design after real users and data arrive. On affected production paths, consider the relevant limits: tenant isolation, authoritative backend authorization, bounded data access, concurrency, idempotency, retries, stale work, time-based state, external contracts, and secret-safe failures. Scale the design to evidence, not imaginary infrastructure.

Choose a maintainable current design over “temporary” architecture. If simplicity creates a real ceiling, make the ceiling explicit. Legacy behavior earns its cost only when deployed data, clients, or the user require it; otherwise replace the obsolete path cleanly.

## Tests are evidence

Test count is not a goal. Test observable outcomes at public seams so the suite reads like a specification and survives internal refactors.

- A bug fix gets the smallest regression test that fails for the defect.
- Start new behavior with one high-value example. Add another only for a distinct behavior or risk, not a branch, function, or permutation.
- Prefer the existing seam and harness. Add a fixture or test file only for a genuinely new boundary or setup.
- Assert through public behavior. Private methods, internal call order, and mocks of code we own make brittle tests.
- Derive expected values from an independent fact, never a copy of the implementation.

Run the narrowest relevant tests and static checks while iterating. Before completion, verify each changed package and boundary. Use repository-wide checks for cross-cutting or release-critical work. A green suite proves only what it exercises.

## Keep changes honest

Make every changed line trace to the requested outcome or its necessary root fix. Match local conventions, remove superseded paths and artifacts, and leave unrelated cleanup for separate work.
