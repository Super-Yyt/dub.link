/**
 * Minimal template engine for Tinybird .pipe files.
 *
 * Supports the Tinybird (Jinja-like) constructs used across Dub's pipes:
 *   {% if <expr> %} {% elif <expr> %} {% else %} {% end %}
 *   {% for item in <expr> %} {% end %}
 *   {% set name = <expr> %}
 *   {{ <expr> }}
 *
 * Expressions:
 *   defined(name)                    boolean
 *   String(name) / Boolean(name)     raw param values (for comparisons)
 *   JSON(name, default)              parsed JSON value
 *   name.get('key', default)         dict access
 *   name.split('.')[idx]             string split
 *   name.startswith('x')             boolean
 *   a == 'x' | a != 'x' | a and b | a or b | Boolean(x) == 1
 *
 * Interpolations render SQL literals:
 *   String(x, default?)        -> 'escaped string'
 *   Array(x, 'String')         -> ['a', 'b']
 *   DateTime(x) / DateTime64(x)-> 'YYYY-MM-DD HH:MM:SS[.mmm]'
 *   Int32(x) / UInt16(x) / ... -> integer
 *   <name>                     -> context value rendered as a literal
 */

export class TemplateError extends Error {}

// ------------------------------------------------------------------ lexer

const TOKEN_RE = /({%[\s\S]*?%}|{{[\s\S]*?}})/g;

function tokenize(text) {
  const parts = text.split(TOKEN_RE);
  return parts.filter((p) => p !== "");
}

// -------------------------------------------------------------------- AST

function parse(tokens) {
  const root = { type: "root", children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  // where the next token goes: into the current if-clause when the
  // innermost block is an if, otherwise into the block's own children
  const appendTo = () => {
    const node = top();
    if (node.type === "if") return node.clauses[node.clauses.length - 1].children;
    return node.children;
  };

  for (const token of tokens) {
    if (token.startsWith("{{")) {
      appendTo().push({ type: "interp", expr: token.slice(2, -2).trim() });
    } else if (token.startsWith("{%")) {
      const stmt = token.slice(2, -2).trim();
      if (stmt.startsWith("if ")) {
        const node = { type: "if", clauses: [{ expr: stmt.slice(3).trim(), children: [] }] };
        appendTo().push(node);
        stack.push(node);
      } else if (stmt.startsWith("elif ")) {
        const node = top();
        if (node.type !== "if") throw new TemplateError("elif outside if: " + stmt);
        node.clauses.push({ expr: stmt.slice(5).trim(), children: [] });
      } else if (stmt === "else") {
        const node = top();
        if (node.type !== "if") throw new TemplateError("else outside if");
        node.clauses.push({ expr: null, children: [] });
      } else if (stmt.startsWith("for ")) {
        const m = stmt.match(/^for\s+([\w.]+)\s+in\s+([\s\S]+)$/);
        if (!m) throw new TemplateError("bad for: " + stmt);
        const node = { type: "for", varName: m[1], iterExpr: m[2].trim(), children: [] };
        appendTo().push(node);
        stack.push(node);
      } else if (stmt.startsWith("set ")) {
        const m = stmt.match(/^set\s+([\w]+)\s*=\s*([\s\S]+)$/);
        if (!m) throw new TemplateError("bad set: " + stmt);
        appendTo().push({ type: "set", varName: m[1], expr: m[2].trim() });
      } else if (stmt === "end") {
        stack.pop();
        if (stack.length === 0) throw new TemplateError("unbalanced end");
      } else {
        throw new TemplateError("unsupported statement: " + stmt);
      }
    } else {
      appendTo().push({ type: "text", text: token });
    }
  }
  if (stack.length !== 1) throw new TemplateError("unclosed block");
  return root;
}

// ------------------------------------------------------------ expressions

export function evalExpression(expr, ctx) {
  expr = expr.trim();

  const orParts = splitLogical(expr, "or");
  if (orParts.length > 1) {
    return orParts.some((p) => truthy(evalExpression(p, ctx)));
  }
  const andParts = splitLogical(expr, "and");
  if (andParts.length > 1) {
    return andParts.every((p) => truthy(evalExpression(p, ctx)));
  }

  const cmp = expr.match(/^(.+?)(==|!=|>=|<=|>|<)(.+)$/);
  if (cmp) {
    const left = evalValue(cmp[1].trim(), ctx);
    const right = evalValue(cmp[3].trim(), ctx);
    switch (cmp[2]) {
      case "==": return left == right; // eslint-disable-line eqeqeq
      case "!=": return left != right; // eslint-disable-line eqeqeq
      case ">=": return left >= right;
      case "<=": return left <= right;
      case ">": return left > right;
      case "<": return left < right;
    }
  }

  const value = evalValue(expr, ctx);
  return truthy(value);
}

function splitLogical(expr, op) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (quote) {
      current += ch;
      if (ch === quote && expr[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (
      depth === 0 &&
      expr[i - 1] === " " &&
      expr.startsWith(op + " ", i)
    ) {
      parts.push(current.trim());
      current = "";
      i += op.length;
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts.filter((p) => p !== "");
}

function truthy(v) {
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "string") return v !== "" && v !== "false" && v !== "0";
  return Boolean(v);
}

// value-level evaluation (no boolean logic)
function evalValue(expr, ctx) {
  expr = expr.trim();
  if (expr === "") return "";

  // string literal
  const str = expr.match(/^'(.*)'$/s) || expr.match(/^"(.*)"$/s);
  if (str) return str[1];

  // number literal
  if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);

  // defined(name)
  let m = expr.match(/^defined\(\s*([\w.]+)\s*\)$/);
  if (m) return resolveName(m[1], ctx) !== undefined;

  // String(name, ...) — raw string value of a param
  m = expr.match(/^String\(\s*([\w.]+)\s*(?:,.*)?\)$/);
  if (m) return resolveName(m[1], ctx);

  // Boolean(name)
  m = expr.match(/^Boolean\(\s*([\w.]+)\s*(?:,.*)?\)$/);
  if (m) {
    const v = resolveName(m[1], ctx);
    return v === true || v === "true" || v === "1" || v === 1 ? 1 : 0;
  }

  // JSON(name, 'default')
  m = expr.match(/^JSON\(\s*([\w.]+)\s*(?:,\s*'([\s\S]*)')?\s*\)$/);
  if (m) {
    const v = resolveName(m[1], ctx);
    if (v === undefined || v === null || v === "") {
      return m[2] !== undefined ? JSON.parse(m[2]) : undefined;
    }
    try {
      return typeof v === "string" ? JSON.parse(v) : v;
    } catch {
      return m[2] !== undefined ? JSON.parse(m[2]) : undefined;
    }
  }

  // Array(name, 'Type')
  m = expr.match(/^Array\(\s*([\w.]+)\s*(?:,\s*'\w+')?\s*\)$/);
  if (m) return toArrayValue(resolveName(m[1], ctx));

  // chained method calls: base.get('k','d').split('.')[1] etc.
  if (/^[\w.]+\.(get|split|startswith)\(/.test(expr)) {
    return evalChain(expr, ctx);
  }

  // <expr>.startswith('x')
  m = expr.match(/^([\w.()]+)\.startswith\(\s*'([\s\S]*)'\s*\)$/);
  if (m) {
    const v = evalValue(m[1], ctx);
    return typeof v === "string" ? v.startsWith(m[2]) : false;
  }

  // <expr>.split('.')[n]
  m = expr.match(/^([\w.()]+)\.split\(\s*'(.)'\s*\)\[(\d+)\]$/);
  if (m) {
    const v = evalValue(m[1], ctx);
    return typeof v === "string" ? v.split(m[2])[Number(m[3])] : undefined;
  }

  // <expr>.get('key', default?) — dict access
  m = expr.match(/^([\w.()]+)\.get\(\s*'([^']*)'\s*(?:,\s*('([\s\S]*)'|[^,()]+))?\s*\)$/);
  if (m) {
    const obj = evalValue(m[1], ctx);
    const hasDefault = m[3] !== undefined && m[3] !== "";
    if (obj && typeof obj === "object") {
      const v = obj[m[2]];
      if (v === undefined || v === null) {
        return hasDefault ? evalValue(stripQuotes(m[3]), ctx) : undefined;
      }
      return v;
    }
    return hasDefault ? evalValue(stripQuotes(m[3]), ctx) : undefined;
  }

  // bare identifier / dotted path
  if (/^[\w.]+$/.test(expr)) {
    return resolveName(expr, ctx);
  }

  throw new TemplateError("cannot evaluate expression: " + expr);
}

function evalChain(expr, ctx) {
  // base(.method(args))*([idx])* — evaluated left to right
  const baseMatch = expr.match(/^[\w.]+(?=\.(get|split|startswith)\()/);
  if (!baseMatch) throw new TemplateError("cannot evaluate: " + expr);
  let value = resolveName(baseMatch[0], ctx);
  let rest = expr.slice(baseMatch[0].length);
  while (rest.length > 0) {
    let m = rest.match(/^\.get\(\s*'([^']*)'\s*(?:,\s*('([^']*)'|[^,()]+))?\s*\)/);
    if (m) {
      if (value && typeof value === "object" && value[m[1]] !== undefined && value[m[1]] !== null) {
        value = value[m[1]];
      } else if (m[2] !== undefined) {
        value = stripQuotes(m[2].trim());
      } else {
        value = undefined;
      }
      rest = rest.slice(m[0].length);
      continue;
    }
    m = rest.match(/^\.split\(\s*'(.)'\s*\)/);
    if (m) {
      value = typeof value === "string" ? value.split(m[1]) : undefined;
      rest = rest.slice(m[0].length);
      continue;
    }
    m = rest.match(/^\.startswith\(\s*'([^']*)'\s*\)/);
    if (m) {
      value = typeof value === "string" ? value.startsWith(m[1]) : false;
      rest = rest.slice(m[0].length);
      continue;
    }
    m = rest.match(/^\[(\d+)\]/);
    if (m) {
      value = value === undefined || value === null ? undefined : value[Number(m[1])];
      rest = rest.slice(m[0].length);
      continue;
    }
    throw new TemplateError("cannot evaluate chain at: " + rest);
  }
  return value;
}

function stripQuotes(s) {
  if (s === undefined) return s;
  const t = s.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  return t;
}

function resolveName(name, ctx) {
  if (name in ctx.locals) return ctx.locals[name];
  if (name in ctx.params) return ctx.params[name];
  const parts = name.split(".");
  let base = ctx.locals[parts[0]] !== undefined ? ctx.locals[parts[0]] : ctx.params[parts[0]];
  for (let i = 1; i < parts.length; i++) {
    if (base === undefined || base === null) return undefined;
    base = base[parts[i]];
  }
  return base;
}

function toArrayValue(v) {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v;
  return String(v).split(",").map((s) => s.trim()).filter((s) => s !== "");
}

// ------------------------------------------------------ SQL literal output

function sqlString(s) {
  if (s === undefined || s === null) return "''";
  return "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
}

export function sqlLiteral(v) {
  if (v === undefined || v === null) return "''";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  if (Array.isArray(v)) return "[" + v.map(sqlLiteral).join(", ") + "]";
  if (typeof v === "object") return sqlString(JSON.stringify(v));
  return sqlString(v);
}

function parseDateTimeValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") {
    const ms = v > 1e12 ? v : v * 1000;
    return new Date(ms);
  }
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return new Date(n > 1e12 ? n : n * 1000);
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function pad(n, w) {
  w = w || 2;
  return String(n).padStart(w, "0");
}

function formatDateTime(v, withMs) {
  const d = parseDateTimeValue(v);
  if (!d) return "''";
  const base =
    d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) +
    " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds());
  return withMs ? sqlString(base + "." + pad(d.getUTCMilliseconds(), 3)) : sqlString(base);
}

// -------------------------------------------------------------- rendering

function evalInterpolation(expr, ctx) {
  expr = expr.trim();

  // String(name, 'default', kwargs...) — only the first extra arg is the default
  let m = expr.match(/^String\(\s*([\w.]+)\s*(?:,\s*('[^']*'|[^,)]+))?/);
  if (m) {
    let v = resolveName(m[1], ctx);
    if ((v === undefined || v === null) && m[2] !== undefined) {
      v = stripQuotes(m[2].trim());
    }
    return sqlLiteral(typeof v === "object" && v !== null ? JSON.stringify(v) : v);
  }

  m = expr.match(/^(DateTime64|DateTime)\(\s*([\w.]+)\s*(?:,.*)?\)$/);
  if (m) {
    const v = resolveName(m[2], ctx);
    return formatDateTime(v, m[1] === "DateTime64");
  }

  m = expr.match(/^(Int8|Int16|Int32|Int64|UInt8|UInt16|UInt32|UInt64|Float32|Float64)\(\s*([\w.]+)\s*(?:,.*)?\)$/);
  if (m) {
    const v = resolveName(m[2], ctx);
    const n = Number(v);
    return isFinite(n) ? String(n) : "0";
  }

  m = expr.match(/^Array\(\s*([\w.]+)\s*(?:,\s*'(\w+)'\s*)?\)$/);
  if (m) {
    const v = toArrayValue(resolveName(m[1], ctx));
    const quoted = v.map((x) => (typeof x === "number" ? String(x) : sqlLiteral(x)));
    return "[" + quoted.join(", ") + "]";
  }

  m = expr.match(/^Boolean\(\s*([\w.]+)\s*(?:,.*)?\)$/);
  if (m) {
    const v = resolveName(m[1], ctx);
    return v === true || v === "true" || v === "1" || v === 1 ? "1" : "0";
  }

  // plain value expression -> literal
  const v = evalValue(expr, ctx);
  return sqlLiteral(v);
}

function truthyEval(expr, ctx) {
  try {
    return evalExpression(expr, ctx);
  } catch (err) {
    if (err instanceof TemplateError) {
      return false;
    }
    throw err;
  }
}

export function renderNode(node, ctx, out) {
  for (const child of node.children) {
    if (child.type === "text") {
      out.push(child.text);
    } else if (child.type === "interp") {
      out.push(evalInterpolation(child.expr, ctx));
    } else if (child.type === "set") {
      ctx.locals[child.varName] = evalValue(child.expr, ctx);
    } else if (child.type === "if") {
      for (const clause of child.clauses) {
        if (clause.expr === null || truthyEval(clause.expr, ctx)) {
          renderNode({ children: clause.children }, ctx, out);
          break;
        }
      }
    } else if (child.type === "for") {
      const iterable = evalValue(child.iterExpr, ctx);
      const items = Array.isArray(iterable) ? iterable : [iterable];
      for (const item of items) {
        if (item === undefined || item === null) continue;
        ctx.locals[child.varName] = item;
        renderNode(child, ctx, out);
      }
      delete ctx.locals[child.varName];
    }
  }
}

export function renderTemplate(text, params) {
  const tokens = tokenize(text);
  const ast = parse(tokens);
  const ctx = { params: params || {}, locals: {} };
  const out = [];
  renderNode(ast, ctx, out);
  return out.join("");
}
