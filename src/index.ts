import prettier from "prettier";
import prettierParserBabel from "prettier/parser-babel";
import prettierParserTypescript from "prettier/parser-typescript";
import { createContext as createContextFallback } from "tailwindcss/lib/lib/setupContextUtils";
import { generateRules as generateRulesFallback } from "tailwindcss/lib/lib/generateRules";
import resolveConfigFallback from "tailwindcss/resolveConfig";
import * as path from "path";
import requireFrom from "import-from";
import requireFresh from "import-fresh";
import objectHash from "object-hash";
import escalade from "escalade/sync";

let contextMap = new Map();

const TW_GROUP_CONTENT = /[A-z\-:]+:\((.*)\)/g;

function sortClasses(
  classStr: string,
  { env, ignoreFirst = false, ignoreLast = false }
) {
  if (typeof classStr !== "string" || classStr === "") {
    return classStr;
  }

  let result = "";
  let groups = classStr.matchAll(TW_GROUP_CONTENT);
  let parts = classStr.replace(TW_GROUP_CONTENT, "").trim().split(/(\s+)/);

  let classes = parts.filter((_, i) => i % 2 === 0);
  let whitespace = parts.filter((_, i) => i % 2 !== 0);

  if (classes[classes.length - 1] === "") {
    classes.pop();
  }

  let prefix = "";
  if (ignoreFirst) {
    prefix = `${classes.shift() ?? ""}${whitespace.shift() ?? ""}`;
  }

  let suffix = "";
  if (ignoreLast) {
    suffix = `${whitespace.pop() ?? ""}${classes.pop() ?? ""}`;
  }

  let classNamesWithOrder: Array<[string, null | bigint]> =
    env.context.getClassOrder(classes);

  classes = classNamesWithOrder
    .sort(([, a], [, z]) => {
      if (a === z) return 0;
      // if (a === null) return options.unknownClassPosition === 'start' ? -1 : 1
      // if (z === null) return options.unknownClassPosition === 'start' ? 1 : -1
      if (a === null) return -1;
      if (z === null) return 1;
      const b = a - z;
      return Number(b > 0n) - Number(b < 0n);
    })
    .map(([className]) => className);

  for (let [group, content] of groups) {
    const sortedGroupContent = sortClasses(content, { env });
    group = group.replace(/\(.*\)/, `(${sortedGroupContent})`);
    classes.push(group);
  }

  result += classes.join(" ");

  return prefix + result + suffix;
}

function createParser(original: prettier.Parser, transform): prettier.Parser {
  return {
    ...original,
    parse(text, parsers, options) {
      let ast = original.parse(text, parsers, options);
      let tailwindConfigPath = "__default__";
      let tailwindConfig = {};
      let resolveConfig = resolveConfigFallback;
      let createContext = createContextFallback;
      let generateRules = generateRulesFallback;

      let baseDir;
      let prettierConfigPath = prettier.resolveConfigFile.sync(
        options.filepath
      );

      if (options.tailwindConfig) {
        baseDir = prettierConfigPath
          ? path.dirname(prettierConfigPath)
          : process.cwd();
        tailwindConfigPath = path.resolve(baseDir, options.tailwindConfig);
        tailwindConfig = requireFresh(tailwindConfigPath);
      } else {
        baseDir = prettierConfigPath
          ? path.dirname(prettierConfigPath)
          : options.filepath
          ? path.dirname(options.filepath)
          : process.cwd();
        let configPath;
        try {
          configPath = escalade(baseDir, (_dir, names) => {
            if (names.includes("tailwind.config.js")) {
              return "tailwind.config.js";
            }
            if (names.includes("tailwind.config.cjs")) {
              return "tailwind.config.cjs";
            }
          });
        } catch {}
        if (configPath) {
          tailwindConfigPath = configPath;
          tailwindConfig = requireFresh(configPath);
        }
      }

      try {
        resolveConfig = requireFrom(baseDir, "tailwindcss/resolveConfig");
        createContext = requireFrom(
          baseDir,
          "tailwindcss/lib/lib/setupContextUtils"
        ).createContext;
        generateRules = requireFrom(
          baseDir,
          "tailwindcss/lib/lib/generateRules"
        ).generateRules;
      } catch {}

      // suppress "empty content" warning
      tailwindConfig.content = ["no-op"];

      let context;
      let existing = contextMap.get(tailwindConfigPath);
      let hash = objectHash(tailwindConfig);

      if (existing && existing.hash === hash) {
        context = existing.context;
      } else {
        context = createContext(resolveConfig(tailwindConfig));
        contextMap.set(tailwindConfigPath, { context, hash });
      }

      transform(ast, { env: { context, generateRules } });
      return ast;
    },
  };
}

function sortStringLiteral(node, { env }) {
  let result = sortClasses(node.value, { env });
  let didChange = result !== node.value;
  node.value = result;
  if (node.extra) {
    // JavaScript (StringLiteral)
    let raw = node.extra.raw;
    node.extra = {
      ...node.extra,
      rawValue: result,
      raw: raw[0] + result + raw.slice(-1),
    };
  } else {
    // TypeScript (Literal)
    let raw = node.raw;
    node.raw = raw[0] + result + raw.slice(-1);
  }
  return didChange;
}

function isStringLiteral(node: { type: string; value: string }) {
  return (
    node.type === "StringLiteral" ||
    (node.type === "Literal" && typeof node.value === "string")
  );
}

function sortTemplateLiteral(node, { env }) {
  let didChange = false;

  for (let i = 0; i < node.quasis.length; i++) {
    let quasi = node.quasis[i];
    let same = quasi.value.raw === quasi.value.cooked;
    let originalRaw = quasi.value.raw;
    let originalCooked = quasi.value.cooked;

    const sort = (value: string) =>
      sortClasses(value, {
        env,
        ignoreFirst: i > 0 && !/^\s/.test(value),
        ignoreLast: i < node.expressions.length && !/\s$/.test(value),
      });

    quasi.value.raw = sort(quasi.value.raw);
    quasi.value.cooked = same ? quasi.value.raw : sort(quasi.value.cooked);

    if (
      quasi.value.raw !== originalRaw ||
      quasi.value.cooked !== originalCooked
    ) {
      didChange = true;
    }
  }

  return didChange;
}

function transformJavaScript(ast, { env }) {
  visit(ast, {
    TaggedTemplateExpression(node) {
      if (node.tag.name === "tw") {
        sortTemplateLiteral(node.quasi, { env });
      }
    },
    JSXAttribute(node) {
      if (!node.value) {
        return;
      }

      if (["tw"].includes(node.name.name)) {
        if (isStringLiteral(node.value)) {
          sortStringLiteral(node.value, { env });
        } else if (node.value.type === "JSXExpressionContainer") {
          visit(node.value, (node, parent, key) => {
            if (isStringLiteral(node)) {
              sortStringLiteral(node, { env });
            } else if (node.type === "TemplateLiteral") {
              sortTemplateLiteral(node, { env });
            }
          });
        }
      }
    },
  });
}

export const parsers = {
  babel: createParser(prettierParserBabel.parsers.babel, transformJavaScript),
  typescript: createParser(
    prettierParserTypescript.parsers.typescript,
    transformJavaScript
  ),
  "babel-ts": createParser(
    prettierParserBabel.parsers["babel-ts"],
    transformJavaScript
  ),
  __js_expression: createParser(
    prettierParserBabel.parsers.__js_expression,
    transformJavaScript
  ),
};

// https://lihautan.com/manipulating-ast-with-javascript/
function visit(ast, callbackMap) {
  function _visit(node, parent, key, index) {
    if (typeof callbackMap === "function") {
      if (callbackMap(node, parent, key, index) === false) {
        return;
      }
    } else if (node.type in callbackMap) {
      if (callbackMap[node.type](node, parent, key, index) === false) {
        return;
      }
    }

    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i++) {
      const child = node[keys[i]];
      if (Array.isArray(child)) {
        for (let j = 0; j < child.length; j++) {
          if (child[j] !== null) {
            _visit(child[j], node, keys[i], j);
          }
        }
      } else if (typeof child?.type === "string") {
        _visit(child, node, keys[i], i);
      }
    }
  }
  _visit(ast);
}
