import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button } from "./ui";

describe("Button", () => {
  it("remains disabled while busy even when disabled is explicitly false", () => {
    render(
      <Button type="button" busy disabled={false}>
        Ask local advisor
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Ask local advisor" });

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });
});
