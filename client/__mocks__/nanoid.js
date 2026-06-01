// Jest mock for the ESM-only `nanoid` package. `next/jest` does not transform
// `nanoid`'s ESM build, which breaks any test that imports `@spinner/shared-types`
// runtime values (its id helpers `require('nanoid')`). Tests don't need real random
// ids, so this returns deterministic, counter-based strings.
let counter = 0;

function customAlphabet(alphabet, size = 21) {
  return (length = size) => {
    counter += 1;
    const seed = `${counter}`;
    return seed.padStart(length, alphabet[0] ?? '0').slice(-length);
  };
}

function nanoid(size = 21) {
  counter += 1;
  return `${counter}`.padStart(size, '0').slice(-size);
}

const urlAlphabet = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';

module.exports = { customAlphabet, nanoid, urlAlphabet };
