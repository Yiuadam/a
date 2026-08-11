/** Exact, non-exponential decimal arithmetic for provider-reported money. */

interface Decimal {
  coefficient: bigint;
  scale: number;
}

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TEN = BigInt(10);

function parse(value: string): Decimal {
  const trimmed = value.trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) throw new Error(`Invalid decimal amount: ${JSON.stringify(value)}`);
  const fraction = match[3] ?? "";
  const sign = match[1] === "-" ? -ONE : ONE;
  return {
    coefficient: sign * BigInt(`${match[2]}${fraction}`),
    scale: fraction.length,
  };
}

function power10(exponent: number): bigint {
  return TEN ** BigInt(exponent);
}

function format(decimal: Decimal): string {
  if (decimal.coefficient === ZERO) return "0";

  const negative = decimal.coefficient < ZERO;
  let digits = (negative ? -decimal.coefficient : decimal.coefficient).toString();
  if (decimal.scale > 0) {
    digits = digits.padStart(decimal.scale + 1, "0");
    const split = digits.length - decimal.scale;
    digits = `${digits.slice(0, split)}.${digits.slice(split)}`;
    digits = digits.replace(/0+$/, "").replace(/\.$/, "");
  }
  return `${negative ? "-" : ""}${digits}`;
}

export function addDecimal(...values: string[]): string {
  if (values.length === 0) return "0";
  const parsed = values.map(parse);
  const scale = Math.max(...parsed.map((value) => value.scale));
  const coefficient = parsed.reduce(
    (sum, value) => sum + value.coefficient * power10(scale - value.scale),
    ZERO,
  );
  return format({ coefficient, scale });
}

export function subtractDecimal(left: string, right: string): string {
  const value = parse(right);
  return addDecimal(left, format({ coefficient: -value.coefficient, scale: value.scale }));
}

export function normaliseDecimal(value: string): string {
  return format(parse(value));
}
