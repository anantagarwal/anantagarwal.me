---
author: Anant Agarwal
pubDatetime: 2026-11-14T08:08:12Z
title: "Software Craftsmanship in the AI Era"
featured: false
draft: false
tags:
  - software-craftsmanship
  - ai
  - software-engineering
description: "Why Sandro Mancuso's ideas on professionalism, pragmatism, and pride matter more when code generation is cheap and review is the bottleneck."
---

When code becomes cheap to generate, the temptation is to treat engineering like a prompt-and-merge assembly line. Sandro Mancuso's _The Software Craftsman: Professionalism, Pragmatism, Pride_ was written in 2014 to push back against a different version of the same problem: developers treated as factory workers whose job was to type out tickets as fast as possible.

Re-reading its core ideas today, almost nothing about the book feels dated. AI coding agents changed how fast we produce diffs, not who is accountable when those diffs hit production.

## From order taker to professional

A central theme in Mancuso's book is the difference between an order taker and a professional. An order taker says "yes" to every request, cuts corners to hit arbitrary deadlines, and blames management when the system rots. A professional acts more like a doctor or an architect: they listen to the business problem, explain risks honestly, push back when a shortcut will cause real harm, and propose practical alternatives.

AI brings the order-taker mindset back in a subtler form. When stakeholders assume an agent can build any feature in an afternoon, pushing back feels harder. And when an agent hands you a working-looking 400-line diff in ten seconds, it is easy to become an order taker for your own tools: accept the output, skip the edge cases, and move on to the next ticket.

Saying "no" in the AI era means two things. First, pushing back on timelines inflated by demo-driven expectations. Second, rejecting plausible-looking generated code that introduces silent failure modes, unnecessary abstractions, or security gaps. Your job is still to protect the health of the system and the outcome for the user, not to maximize lines merged per hour.

## Pragmatism is not gold-plating

Software craftsmanship sometimes gets caricatured as obsession over spotless code, rigid TDD dogma, or rewriting working modules for aesthetic satisfaction. Mancuso explicitly argues against that. Pragmatism is in the subtitle of the book for a reason: craftsmanship is about delivering value responsibly, not chasing perfection in a vacuum.

That distinction matters even more with coding agents. Left unguided, agents love to over-engineer: adding speculative interfaces, duplicating helpers instead of reusing existing ones, or wrapping simple logic in three layers of indirection. At the same time, under-engineering with AI looks like copy-pasting generated blocks across five files because it was faster than thinking about the boundary.

Pragmatic engineers use AI for leverage without surrendering design judgment. They let an agent scaffold boilerplate, draft test cases, or explore an unfamiliar API, then step in to simplify the shape of the code before it lands. They know when a quick prototype is fine to throw away and when a core path needs careful modeling, strict types, and tests that actually verify behavior rather than mirroring implementation details.

## Pride means owning the outcome

In the book, pride is not ego. It is caring enough about your work to stand behind it. When a system goes down at 2 AM, nobody cares whether the bug was typed by hand or produced by a model. "The AI wrote it" is not an engineering postmortem.

Pride in an AI-assisted workflow shifts where you spend your attention:

- **Reading over writing:** If an agent writes 80% of a change, you still need to read 100% of it with the skepticism you would apply to a rushed pull request.
- **Verification as a habit:** Fast generation makes automated checks (type-checking, linting, integration tests, and clean diffs) non-negotiable. Without a tight feedback loop, speed just compounds defects faster.
- **Leaving the codebase cleaner:** Mancuso emphasizes the Boy Scout Rule: leave the code a little better than you found it. With AI, it is remarkably easy to leave behind orphaned helpers, dead flags, and verbose comments that explain _what_ a loop does instead of _why_ a constraint exists. Cleaning up after your tools is part of the craft.

## Owning your growth when tools do the typing

One of Mancuso's strongest arguments is that your career belongs to you, not your employer. Waiting for a company to schedule training or hand you greenfield projects is a slow way to stagnate. Professionals practice deliberately, study fundamentals, and build their own judgment outside the narrow slice of work on their current sprint board.

This is the quiet trap of the AI era. Junior and senior engineers alike can now ship features in languages and frameworks they barely understand. In the short term, that feels like a superpower. Over a couple of years, skipping the struggle of debugging, data modeling, and reading documentation hollows out the exact mental models you need to tell when an agent is hallucinating or leading you into a bad architecture.

Deliberate practice today looks slightly different, though the principle is the same. Sometimes it means turning autocomplete off to implement a tricky algorithm or state machine yourself. Often it means reading the underlying library source code, profiling a slow query by hand, or asking a model to challenge your design rather than write the code for you. Tools amplify judgment; they do not replace the need to build it.

## What actually changed

Mancuso wrote extensively about pairing, two-way technical interviews, and building teams that care about engineering culture. Those human parts of software have not been automated away. If anything, when individual output is multiplied by agents, team alignment on architecture, review standards, and shared ownership becomes the real constraint.

_The Software Craftsman_ was never really about typing speed or memorizing design patterns. It was about how you treat your work, your teammates, and the people who rely on what you ship. AI changed the keyboard, not the craft.
