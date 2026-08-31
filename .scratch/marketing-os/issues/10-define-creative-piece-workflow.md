# Define the Creative Piece workflow

Type: prototype
Status: resolved

## Question

What is the smallest structured Creative Piece schema, lifecycle, editor, versioning model, Brand Kit behavior, validation contract, template system, preview, export, Content Backlog, and calendar behavior needed for the MVP?

## Answer

The workflow was settled through grilling, then validated in an interactive logic prototype the Operator approved: [creative-piece-workflow.html](../prototypes/creative-piece-workflow.html) (single self-contained file; open it and run the five guided walkthroughs). Its pure `CreativePieceMachine` module is the liftable reference implementation of these rules.

### Lifecycle

`backlog → drafting → review → approved → planned → exported → measured`, with a changes-requested loop from review back to drafting. Reopening an approved or planned piece returns it to drafting and clears its approval and planned date; it must pass review again.

### Schema

A Creative Piece is a record (title, status, format, version, planned date) plus a portable PieceDoc: schema version, 1–20 slides of ordered layers, and per-network captions for Instagram, X, LinkedIn, and TikTok (no language or translation lineage yet). MVP layer types are text, image, shape, and logo across four formats (4:5, 1:1, 9:16, 16:9). Code-drawn artifact layers (EvidenceArtifact/ProductArtifact) are deferred until the basic renderer works.

### Editor and versioning

The Operator and the AI Host edit the same document through atomic typed edit batches: at most 20 operations bound to a `baseVersion`. A stale base version returns `version_conflict` and changes nothing; a structural error rejects the whole batch; an invalid cosmetic value falls back to a default with a warning. Every applied batch bumps the version, history is append-only, and restoring an old version creates a new one. Edits apply only in backlog and drafting; an approved piece rejects edits until it is reopened, because approval means the Operator saw that exact document.

### Brand Kit behavior

Layers reference brand tokens, never copied values. A kit change repaints backlog and drafting pieces live, but approved and planned pieces keep their rendering pinned to the kit version they were approved against and are flagged brand-outdated. Export is blocked while brand-outdated; re-approval re-pins the kit without disturbing status or planned date.

### Validation

Two deterministic passes. `check_brand` (off-kit colors and fonts, empty text layers, overflow, missing assets) produces errors that block entering approved, plus advisory warnings. `check_quality` produces heuristic findings that are always advisory and never block. Approval runs both automatically.

### Templates, export, backlog, calendar

Save-as-template copies the PieceDoc and strips campaign text, claims, captions, and planning data, keeping layout and token references. Export renders a PNG per slide per format plus a captions file into a local bundle recorded with its doc version and pinned kit version; that bundle is what a distribution Work Order points at. The Content Backlog holds undated pieces; a calendar date is a plan and never implies publishing.
