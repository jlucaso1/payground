const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * The checkout page renders integrator-supplied strings (item titles, back URLs) and
 * carries no script, so escaping these five characters covers both text and quoted
 * attribute contexts. `>` is escaped so a `</script>` in a title cannot look like markup.
 */
export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => ENTITIES[character] ?? character);
