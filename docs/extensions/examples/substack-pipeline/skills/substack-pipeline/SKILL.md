# Substack Pipeline

You drive the `substack-pipeline` extension to turn one source URL into a
polished, original Substack-style article **plus a cover image**, iterating with
the user. The extension owns the deterministic work (summarize, write, revise,
illustrate, image); **you** own the sequencing and the human turn.

## Tools

| Tool                      | When to call                                                                 |
| ------------------------- | ---------------------------------------------------------------------------- |
| `draft_substack_post`     | First. User gave a URL. `{ url, styleNote? }` → returns the first draft.      |
| `ask_user_question`       | The platform's user-prompt tool. Use it for every approve/changes decision.  |
| `revise_substack_post`    | After the user requested changes. `{ feedback }` → returns a revised draft.  |
| `finalize_substack_post`  | Once the user approves. `{}` → returns the final article + cover image.      |

`ask_user_question` is always available — you do **not** need an `![ext:…]`
mention for it. Do **not** summarize, rewrite, or generate the image yourself;
the extension does that deterministically.

## Exact flow

1. User gives a URL → call `draft_substack_post({ url, styleNote? })`. Pass the
   user's tone/angle steer as `styleNote` verbatim if they gave one.
2. Show the returned draft to the user. Then call:
   `ask_user_question({ question: "Approve this draft, or request changes?",
   options: ["Approve", "Request changes"] })`.
3. Branch on the answer:
   - **"Approve"** → call `finalize_substack_post()`. Present its result
     (article + cover image) as-is. Done.
   - **"Request changes"** (or any non-approve answer) → call
     `ask_user_question({ question: "What should change?" })` (no options →
     free text). Take that answer and call
     `revise_substack_post({ feedback: <that answer> })`.
4. Show the revised draft, then go back to step 2.
5. **Cap: after 5 revise rounds**, do one final pass if asked, then call
   `finalize_substack_post()` regardless and tell the user you've reached the
   revision limit. (`revise_substack_post` also reminds you when the cap is hit.)

## Failure modes to surface clearly

- `draft_substack_post` error (bad/unfetchable URL): tell the user the source
  couldn't be read; offer to try a different URL. Do not proceed.
- `NO_SCRATCH` from revise/finalize: the draft state was lost — start over with
  `draft_substack_post`.
- `finalize_substack_post` returns a "Pipeline notes" section (e.g. cover image
  failed): the article still shipped — relay the note honestly, don't hide it.

## Out of scope

No Substack draft creation or publishing here (that's `substack-pilot`). This
pipeline produces the article + image **in chat only** — no credentials. Don't
promise publishing or scheduling.
