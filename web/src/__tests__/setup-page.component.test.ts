/**
 * DOM tests for the first-run admin setup page. This is the very first
 * thing a brand-new install shows, so the contract is non-negotiable:
 *
 *   - All four labeled inputs render (name/email/password/confirm).
 *   - Client-side validation gates the network call entirely — no fetch
 *     fires until name, email, password complexity, and confirm-match
 *     all pass.
 *   - Each error is announced via role="alert" and wired to its input
 *     via aria-describedby so screen readers pair them up.
 *   - On a 4xx with a `fields` map the page routes per-field server
 *     errors next to their inputs (and suppresses the top-level banner).
 *   - On a 4xx without `fields` (e.g. rate limit) the top-level banner
 *     surfaces `data.error`.
 *   - Network failure surfaces a friendly fallback string.
 *   - Happy path POSTs trimmed name + lowercased email + raw password
 *     and navigates to "/".
 */

import "@testing-library/jest-dom/vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import SetupPage from "../routes/(auth)/setup/+page.svelte";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function fillInputs(
  container: HTMLElement,
  values: { name?: string; email?: string; password?: string; confirmPassword?: string },
) {
  if (values.name !== undefined) {
    const input = container.querySelector<HTMLInputElement>("#name")!;
    await fireEvent.input(input, { target: { value: values.name } });
  }
  if (values.email !== undefined) {
    const input = container.querySelector<HTMLInputElement>("#email")!;
    await fireEvent.input(input, { target: { value: values.email } });
  }
  if (values.password !== undefined) {
    const input = container.querySelector<HTMLInputElement>("#password")!;
    await fireEvent.input(input, { target: { value: values.password } });
  }
  if (values.confirmPassword !== undefined) {
    const input = container.querySelector<HTMLInputElement>("#confirmPassword")!;
    await fireEvent.input(input, { target: { value: values.confirmPassword } });
  }
}

async function submit(container: HTMLElement) {
  const form = container.querySelector("form")!;
  await fireEvent.submit(form);
}

describe("Setup page (+page.svelte)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let originalLocation: Location;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    originalLocation = window.location;
    Object.defineProperty(window, "location", {
      value: { href: "" },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });

  test("renders all four labeled inputs and a submit button", () => {
    const { getByLabelText, getByRole } = render(SetupPage);
    expect(getByLabelText("Name")).toBeInTheDocument();
    expect(getByLabelText("Email")).toBeInTheDocument();
    expect(getByLabelText("Password")).toBeInTheDocument();
    expect(getByLabelText("Confirm password")).toBeInTheDocument();
    expect(getByRole("button", { name: /Create Admin Account/i })).toBeInTheDocument();
  });

  test("empty name shows 'Name is required' wired via aria-describedby; fetch not called", async () => {
    const { container, getByText } = render(SetupPage);
    await fillInputs(container, {
      name: "",
      email: "a@b.co",
      password: "Abcdefg1",
      confirmPassword: "Abcdefg1",
    });
    await submit(container);

    const err = getByText("Name is required");
    expect(err).toHaveAttribute("role", "alert");
    expect(err).toHaveAttribute("id", "name-error");

    const nameInput = container.querySelector<HTMLInputElement>("#name")!;
    expect(nameInput).toHaveAttribute("aria-describedby", "name-error");
    expect(nameInput).toHaveAttribute("aria-invalid", "true");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("invalid email shows email error; fetch not called", async () => {
    const { container, getByText } = render(SetupPage);
    await fillInputs(container, {
      name: "Ada",
      email: "not-an-email",
      password: "Abcdefg1",
      confirmPassword: "Abcdefg1",
    });
    await submit(container);

    const err = getByText("Valid email is required");
    expect(err).toHaveAttribute("role", "alert");
    expect(err).toHaveAttribute("id", "email-error");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("too-short password shows the length error", async () => {
    const { container, getByText } = render(SetupPage);
    await fillInputs(container, {
      name: "Ada",
      email: "a@b.co",
      password: "Aa1",
      confirmPassword: "Aa1",
    });
    await submit(container);

    expect(getByText("Password must be at least 8 characters")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("password missing uppercase shows the uppercase complexity error", async () => {
    const { container, getByText } = render(SetupPage);
    await fillInputs(container, {
      name: "Ada",
      email: "a@b.co",
      password: "alllowercase1",
      confirmPassword: "alllowercase1",
    });
    await submit(container);

    expect(getByText("Password must contain an uppercase letter")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("password missing lowercase shows the lowercase complexity error", async () => {
    const { container, getByText } = render(SetupPage);
    await fillInputs(container, {
      name: "Ada",
      email: "a@b.co",
      password: "ALLUPPERCASE1",
      confirmPassword: "ALLUPPERCASE1",
    });
    await submit(container);

    expect(getByText("Password must contain a lowercase letter")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("password missing digit shows the digit complexity error", async () => {
    const { container, getByText } = render(SetupPage);
    await fillInputs(container, {
      name: "Ada",
      email: "a@b.co",
      password: "NoDigitsHere",
      confirmPassword: "NoDigitsHere",
    });
    await submit(container);

    expect(getByText("Password must contain a digit")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("mismatched confirm password shows 'Passwords do not match' and skips fetch", async () => {
    const { container, getByText } = render(SetupPage);
    await fillInputs(container, {
      name: "Ada",
      email: "a@b.co",
      password: "Abcdefg1",
      confirmPassword: "Different1",
    });
    await submit(container);

    expect(getByText("Passwords do not match")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("happy path POSTs trimmed name + lowercased email + raw password and navigates to '/'", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({}, 200));

    const { container } = render(SetupPage);
    await fillInputs(container, {
      name: "  Ada Lovelace  ",
      email: "Ada@Example.COM",
      password: "Abcdefg1",
      confirmPassword: "Abcdefg1",
    });
    await submit(container);

    // Let the awaited fetch + .then chain settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/api/auth/setup");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
      password: "Abcdefg1",
    });

    expect(window.location.href).toBe("/");
  });

  test("400 with fields.password routes the server message into the password slot; no top-level banner", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(
        {
          error: "Validation failed",
          fields: { password: "Password must contain at least one digit" },
        },
        400,
      ),
    );

    const { container, getByText, queryByText } = render(SetupPage);
    await fillInputs(container, {
      name: "Ada",
      email: "a@b.co",
      password: "Abcdefg1",
      confirmPassword: "Abcdefg1",
    });
    await submit(container);

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const err = getByText("Password must contain at least one digit");
    expect(err).toHaveAttribute("role", "alert");
    expect(err).toHaveAttribute("id", "password-error");

    // Top-level banner ("Setup failed" / "Validation failed") must not render
    // when a per-field error already explained the problem.
    expect(queryByText("Setup failed")).toBeNull();
    expect(queryByText("Validation failed")).toBeNull();
  });

  test("429 with no fields surfaces 'Too many requests' in the top-level banner", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ error: "Too many requests" }, 429));

    const { container, getByText } = render(SetupPage);
    await fillInputs(container, {
      name: "Ada",
      email: "a@b.co",
      password: "Abcdefg1",
      confirmPassword: "Abcdefg1",
    });
    await submit(container);

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const banner = getByText("Too many requests");
    expect(banner).toBeInTheDocument();
    // The banner's parent <div> carries role="alert".
    expect(banner.closest('[role="alert"]')).not.toBeNull();
  });

  test("network error (fetch rejects) shows the friendly fallback in the top-level banner", async () => {
    fetchSpy.mockRejectedValue(new Error("offline"));

    const { container, getByText } = render(SetupPage);
    await fillInputs(container, {
      name: "Ada",
      email: "a@b.co",
      password: "Abcdefg1",
      confirmPassword: "Abcdefg1",
    });
    await submit(container);

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const banner = getByText("Network error. Please try again.");
    expect(banner).toBeInTheDocument();
    expect(banner.closest('[role="alert"]')).not.toBeNull();
  });
});
