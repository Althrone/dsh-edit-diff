// Diff Test B — brand-new JS file for the dsh-edit-diff new-file diff.
export const ROMAN = { 1: "I", 5: "V", 10: "X", 50: "L" };

export function toRoman(n) {
  let rest = n;
  let out = "";
  for (const value of [50, 10, 5, 1]) {
    while (rest >= value) {
      out += ROMAN[value];
      rest -= value;
    }
  }
  return out;
}

const DIGITS = { I: 1, V: 5, X: 10, L: 50 };

export function fromRoman(text) {
  let total = 0;
  for (let i = 0; i < text.length; i += 1) {
    const cur = DIGITS[text[i]] ?? 0;
    const next = DIGITS[text[i + 1]] ?? 0;
    total += cur < next ? -cur : cur;
  }
  return total;
}
