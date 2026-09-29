import "react";

/**
 * Lets a `style` object set a CSS custom property such as `--rise-order`,
 * which React already passes through to the element like any other.
 */
declare module "react" {
  interface CSSProperties {
    [property: `--${string}`]: string | number | undefined;
  }
}
