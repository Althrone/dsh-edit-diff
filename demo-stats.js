// Tiny helper created to exercise the dsh-edit-diff plugin (new-file path).
export function summarize(values) {
  if (values.length === 0) return { count: 0, sum: 0, mean: 0 };
  const sum = values.reduce((a, b) => a + b, 0);
  return { count: values.length, sum, mean: sum / values.length };
}

export function formatSummary({ count, sum, mean }) {
  return `${count} item(s), total=${sum}, mean=${mean.toFixed(2)}`;
}
