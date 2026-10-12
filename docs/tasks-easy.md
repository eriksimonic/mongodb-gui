# Easy gap items

Source: docs/gap-matrix.md. Other decided items wait for another day.

## ES2022+ in scripts

- [ ] Run a script using `??`, `?.`, `#private` fields and top-level `await` in the editor.
- [ ] Fix what fails, or mark the matrix row Have.

## mongotop view

- [x] Review the Diagnostics `top` view against mongotop. All columns were there.
- [x] Add an interval picker (manual, 1s, 5s, 10s) and a "Change since last refresh" switch (`TopTab.tsx`, `topDelta` in `top-sort.ts`).
- [ ] Check it against a live server and update the matrix row.

## Test data generator

- [ ] List NoSQLBooster generator options (field types, count, locale, relations).
- [ ] Compare with ours and record the differences in the matrix.
- [ ] Add the cheapest missing option.

## Nested field column groups in the grid

- [ ] Show how dotted paths render today.
- [ ] Decide whether to group nested fields under a parent header. Record the decision in the matrix.
