# MarketingOS

MarketingOS is the workspace where an Operator plans, approves, carries out, and evaluates marketing across several Connected Projects.

## Portfolio

**Connected Project**:
An independently marketed product or business whose facts, brand, audience, goals, and constraints are available to MarketingOS.
_Avoid_: User project, client project, project

**Project Context**:
The sourced facts, brand rules, audience, proof, goals, and constraints that belong to one Connected Project.
_Avoid_: Prompt context, project data

**Operator**:
A person authorized to perform or approve marketing work for a Connected Project. The first Operator is the owner of MarketingOS.
_Avoid_: User, poster, worker

**AI Host**:
The existing AI product through which the Operator asks for reasoning or generation and operates MarketingOS. MarketingOS does not provide the underlying model.
_Avoid_: AI account, model provider, agent

## Reasoning

**Method Library**:
The versioned collection of marketing methods, references, rubrics, and output schemas that guides the AI Host.
_Avoid_: Skill pack, system prompt

## Project exchange

**Project Snapshot**:
An immutable, versioned view of one Connected Project's authoritative context at a specific point in time.
_Avoid_: Cache, current project data

**Context Gap**:
An explicit condition showing that required Project Context is unsupported, empty, stale, invalid, conflicted, or unavailable.
_Avoid_: Missing data, unknown

**Project Change Set**:
An atomic proposal for approved changes to one Connected Project, bound to the Project Snapshot from which it was prepared.
_Avoid_: Patch, write request

**Change Digest**:
The derived identifier of one Project Change Set prepared against one Project Snapshot of one Connected Project. The Operator approves a digest, never a request; the AI Host is told a status and never holds a grant.
_Avoid_: Token, key, id

**Write Policy**:
A Connected Project's own declaration of which Project Change Set operations it accepts, which targets are editable, and which resources are protected. A project that declares nothing permits nothing.
_Avoid_: Permissions, ACL

**Write Receipt**:
The permanent record of an applied Project Change Set and the resulting project resource versions.
_Avoid_: Log, response

## Account operations

**Account Slot**:
The durable social-channel capacity reserved for a Connected Project. It survives the loss or replacement of the platform account that fills it.
_Avoid_: Account, seat

**Account Instance**:
The actual platform identity that currently fills an Account Slot. An Account Instance can be lost, retired, or replaced without changing the slot.
_Avoid_: Account, profile

**Account Warm-up**:
A period of human, niche-relevant activity that prepares an Account Instance for approved distribution work. It does not guarantee reach, safety, or performance.
_Avoid_: Warming, account activation

**Work Order**:
A requested human marketing action with an assignee, instructions, approval policy, and required proof.
_Avoid_: Task, job

**Operator Assignment**:
The authorization for an Operator to perform Work Orders on an Account Instance during a defined period.
_Avoid_: Ownership, claim

## Content and distribution

**Brand Kit**:
The approved visual and verbal identity of a Connected Project, including colors, typography, logos, voice, and usage rules.
_Avoid_: Project Context, design system

**Creative Brief**:
The sourced direction for one marketing artifact, including its objective, audience, idea, evidence, call to action, format, and timing.
_Avoid_: Prompt, request

**Creative Piece**:
A structured, editable marketing composition with versioned content, layout, channel variants, and planning state.
_Avoid_: Post, design, asset

**Marketing Asset**:
An image or other binary file a Creative Piece composes, recorded with its origin, the prompt and source files it came from, and its rights notes. MarketingOS stores and attributes these; it never generates them.
_Avoid_: Image, file, upload

**Creative Template**:
A reusable structure and visual treatment for future Creative Pieces, without campaign-specific claims or results.
_Avoid_: Piece, duplicate

**Content Backlog**:
Creative Pieces that have no planned distribution date yet.
_Avoid_: Drafts, unscheduled posts

**Content Release**:
An approved, immutable version of marketing content prepared for distribution to one or more destinations.
_Avoid_: Post, asset

**Delivery Target**:
One intended delivery of a Content Release to one Account Instance or other destination.
_Avoid_: Publication, post job

**Proof Artifact**:
Evidence submitted by an Operator that a Work Order or Delivery Target was completed as instructed.
_Avoid_: Attachment, screenshot

**Metric Snapshot**:
A timestamped observation of a marketing outcome tied to its source and collection method.
_Avoid_: Metric, result
