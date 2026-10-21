import { describe, expect, it } from "vitest";
import { AUTH_METHODS } from "@/shared/constants/providers";
import {
  AUTH_METHOD_LABELS,
  credentialLabel,
  usesCredential,
} from "@/app/(dashboard)/dashboard/providers/new/authMethods.js";

/**
 * The auth-method registry carries ids only, so the form's labels live next
 * to it. Every registry id needs one, and the form's default has to be an id
 * the registry knows — otherwise no button is selected and the credential
 * field never appears.
 */
describe("new provider auth methods", () => {
  it("labels every method in the registry", () => {
    for (const method of Object.values(AUTH_METHODS)) {
      expect(AUTH_METHOD_LABELS[method.id], `no label for ${method.id}`).toBeTruthy();
    }
  });

  it("asks for a credential only for the methods that carry one", () => {
    expect(usesCredential("apikey")).toBe(true);
    expect(usesCredential("cookie")).toBe(true);
    expect(usesCredential("oauth")).toBe(false);
  });

  it("names the credential after the method", () => {
    expect(credentialLabel("apikey")).toBe("API Key");
    expect(credentialLabel("cookie")).toBe("Cookie Value");
  });
});
