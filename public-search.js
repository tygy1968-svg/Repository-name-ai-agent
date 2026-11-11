// Only public, bounded queries may leave the application. No memory is added.
export function safePublicSearchQuery(value) {
  const query = typeof value === 'string' ? value.trim() : '';
  if (!query || query.length > 500 || /@|\b\d{6}\b|(?:\+?\d[\d\s().-]{7,}\d)|\b(?:sk|bind)_[\w-]+|\bsk-[\w-]+/iu.test(query)) return null;
  return query;
}
