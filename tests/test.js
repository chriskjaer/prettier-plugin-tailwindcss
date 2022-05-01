const prettier = require("prettier");
const path = require("path");
// const { execSync } = require("child_process");

function format(str, options = {}) {
  return prettier
    .format(str, {
      pluginSearchDirs: [__dirname], // disable plugin autoload
      plugins: [path.resolve(__dirname, "..")],
      semi: false,
      singleQuote: true,
      printWidth: 9999,
      parser: "typescript",
      ...options,
    })
    .trim();
}

test("it works", () => {
  expect(format(';<div tw="sm:p-0 p-0" />')).toEqual(
    ';<div tw="p-0 sm:p-0" />'
  );
});

test("literals work", () => {
  expect(format("tw`sm:p-0 p-0 mb-0`")).toEqual("tw`mb-0 p-0 sm:p-0`");
});

test("groups work", () => {
  expect(format("tw`sm:(p-0) p-0`")).toEqual("tw`p-0 sm:(p-0)`");
});

test("sorting within groups work", () => {
  expect(format("tw`sm:(p-0 mb-0) p-0`")).toEqual("tw`p-0 sm:(mb-0 p-0)`");
});

test("advanced jsx works too", () => {
  expect(format(';<div tw="sm:(p-0 mb-0) p-0" />')).toEqual(
    ';<div tw="p-0 sm:(mb-0 p-0)" />'
  );
});

[
  [
    // Fixture 0
    "tw`text-f5 lg:(text-f3 italic leading-snug) mb-2`",
    "tw`text-f5 mb-2 lg:(text-f3 italic leading-snug)`",
  ],
  [
    // Fixture 1
    "tw`hocus:ns:(p-0 mb-0)`",
    "tw`hocus:ns:(mb-0 p-0)`",
  ],
  [
    // Fixture 2
    "tw`lg:(sticky top-4 max-h-[calc(100vh - 2rem)])`",
    "tw`lg:(max-h-[calc(100vh - 2rem)] sticky top-4)`",
  ],
].forEach(([input, output], i) =>
  test(`Fixture ${i}`, () => {
    expect(format(input)).toEqual(output);
  })
);
