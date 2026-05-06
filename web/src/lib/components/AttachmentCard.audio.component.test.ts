/**
 * DOM tests for AttachmentCard's audio branch (Kokoro-TTS feature).
 *
 * Audio-kind attachments now render an inline <audio controls>
 * element instead of falling through to the generic file card. This
 * test pins the new branch's render contract and confirms the
 * existing branches (image, file) keep working as a smoke.
 *
 * Why an inline <audio> element instead of a click-through download:
 * the kokoro-tts card uses the same /api/attachments/{id} URL via
 * AttachmentCard for persisted runs, so playback has to work without
 * any custom plumbing in the message bubble.
 */

import { render, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import AttachmentCard from "./AttachmentCard.svelte";

afterEach(() => cleanup());

describe("AttachmentCard — audio branch", () => {
  test("audio kind renders <audio controls> with the attachment URL", () => {
    const { getByTestId, queryByTestId } = render(AttachmentCard, {
      attachment: {
        id: "att-audio-1",
        filename: "speech.wav",
        mimeType: "audio/wav",
        sizeBytes: 18_000,
        kind: "audio" as const,
      },
    });
    // New branch rendered.
    const card = getByTestId("attachment-card-audio");
    expect(card).toBeInTheDocument();
    // Old generic-file fallback is NOT rendered for audio attachments.
    expect(queryByTestId("attachment-card-file")).toBeNull();

    const audio = card.querySelector("audio");
    expect(audio).not.toBeNull();
    expect(audio).toHaveAttribute("controls");
    expect(audio).toHaveAttribute("preload", "metadata");
    expect(audio).toHaveAttribute("src", "/api/attachments/att-audio-1");
    expect(audio).toHaveAttribute("aria-label", "speech.wav");
  });

  test("image branch (smoke) — still renders <img> via /api/attachments/{id}", () => {
    const { getByTestId } = render(AttachmentCard, {
      attachment: {
        id: "att-img-1",
        filename: "cow.png",
        mimeType: "image/png",
        sizeBytes: 1024,
        kind: "image" as const,
      },
    });
    const card = getByTestId("attachment-card-image");
    const img = card.querySelector("img");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "/api/attachments/att-img-1");
  });

  test("non-audio/non-image branch (smoke) — falls through to the file card", () => {
    const { getByTestId, queryByTestId } = render(AttachmentCard, {
      attachment: {
        id: "att-txt-1",
        filename: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 256,
        kind: "text" as const,
      },
    });
    expect(getByTestId("attachment-card-file")).toBeInTheDocument();
    expect(queryByTestId("attachment-card-audio")).toBeNull();
  });
});
