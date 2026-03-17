import * as he from 'he';

/** Escape HTML special characters, replacing them with named and numerical character references. */
export function escapeHtml(s: string): string {
  return he.encode(s, { useNamedReferences: true });
}

/** Unescape HTML named and numerical character references, replacing them with their normal characters. */
export function unescapeHtml(s: string): string {
  return he.decode(s);
}

/** Escape HTML and HTML-encode all spaces and tabs with their encoded characters. */
export function escapeHtmlAndSpaces(s: string): string {
  return escapeHtml(s).replace(/ /g, '&nbsp;').replace(/\t/g, '&#9;');
}

/**
 * Un-encode HTML single spaces where it's obvious we don't need them to be encoded.
 */
export function unescapeSafeSpacesInHtml(s: string): string {
  // Look for every &nbsp; that is not preceeded by &nbsp;, a tag, or the beginning of the line and is not followed by
  // &nbsp;, a closing tag, or the end of a line.
  return s.replace(/(?<!((&nbsp;)|(>)|^))&nbsp;(?!((&nbsp;)|(<)|$))/gi, ' ');
}

// Borrowed from https://github.com/component/escape-html/blob/master/index.js
/*!
 * escape-html
 * Copyright(c) 2012-2013 TJ Holowaychuk
 * Copyright(c) 2015 Andreas Lubbe
 * Copyright(c) 2015 Tiancheng "Timothy" Gu
 * MIT Licensed
 */

/** Escape Markdown special characters, replacing each one with a backslash and the character. */
export function escapeMarkdown(s: string): string {
  const matchMarkdownCharsRegExp = /[#()*+\-[\\\]_`{}~]/;
  const str = '' + s;
  const match = matchMarkdownCharsRegExp.exec(str);

  if (!match) {
    return str;
  }

  let escape;
  let markdown = '';
  let index = 0;
  let lastIndex = 0;

  for (index = match.index; index < str.length; index++) {
    switch (str.charCodeAt(index)) {
      case 35: // #
        escape = '\\#';
        break;
      case 40: // (
        escape = '\\(';
        break;
      case 41: // )
        escape = '\\)';
        break;
      case 42: // *
        escape = '\\*';
        break;
      case 43: // +
        escape = '\\+';
        break;
      case 45: // -
        escape = '\\-';
        break;
      case 91: // [
        escape = '\\[';
        break;
      case 92: // \
        escape = '\\\\';
        break;
      case 93: // ]
        escape = '\\]';
        break;
      case 95: // _
        escape = '\\_';
        break;
      case 96: // `
        escape = '\\`';
        break;
      case 123: // {
        escape = '\\{';
        break;
      case 125: // }
        escape = '\\}';
        break;
      case 126: // ~
        escape = '\\~';
        break;
      default:
        continue;
    }

    if (lastIndex !== index) {
      markdown += str.substring(lastIndex, index);
    }

    lastIndex = index + 1;
    markdown += escape;
  }

  return lastIndex !== index ? markdown + str.substring(lastIndex, index) : markdown;
}

/** Unescape Markdown special characters, removing escape backslashes from Markdown character sequences. */
export function unescapeMarkdown(s: string): string {
  // Go through the string, character by character. If we see a backslash, check to see if the following character is a
  // Markdown special character. If it is, remove the backslash.
  const matchMarkdownCharsRegExp = /[#()*+\-[\\\]_`{}~.]/;

  let finalString = '';
  for (let i = 0; i < s.length; i++) {
    // If the character is a backslash and there's a character after it.
    if (s.charCodeAt(i) === 92 && i + 1 < s.length) {
      const match = matchMarkdownCharsRegExp.exec(s.substring(i + 1, i + 2));
      if (match) {
        // Skip the backslash.
        i++;
      }
    }
    finalString += s.substring(i, i + 1);
  }

  return finalString;
}

/**
 * Returns `data`, with all newliney characters removed, as defined by table 5.1 in:
 * http://unicode.org/versions/Unicode5.2.0/ch05.pdf
 * Newlines will be substituted with `replace` for every instance of a newliney character. If `replace` is not provided,
 * newliney characters will be removed.
 */
export function replaceNewlines(data: string, replace = ''): string {
  // From table 5.1 in http://unicode.org/versions/Unicode5.2.0/ch05.pdf
  // eslint-disable-next-line no-control-regex
  return data.replace(/(\r\n|\r|\n|\u0085|\v|\u000C|\u2028|\u2029)/gm, replace);
}

export type HtmlBlockLevelTag =
  | 'address'
  | 'article'
  | 'aside'
  | 'blockquote'
  | 'details'
  | 'dialog'
  | 'dd'
  | 'div'
  | 'dl'
  | 'dt'
  | 'fieldset'
  | 'figcaption'
  | 'figure'
  | 'footer'
  | 'form'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'header'
  | 'hgroup'
  | 'hr'
  | 'li'
  | 'main'
  | 'nav'
  | 'ol'
  | 'p'
  | 'pre'
  | 'section'
  | 'table'
  | 'ul';

export function isHtmlBlockLevelTag(tagName: unknown): tagName is HtmlBlockLevelTag {
  if (tagName === undefined || tagName === null || typeof tagName !== 'string') {
    return false;
  }
  const blockLevelTags = [
    'address',
    'article',
    'aside',
    'blockquote',
    'details',
    'dialog',
    'dd',
    'div',
    'dl',
    'dt',
    'fieldset',
    'figcaption',
    'figure',
    'footer',
    'form',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'header',
    'hgroup',
    'hr',
    'li',
    'main',
    'nav',
    'ol',
    'p',
    'pre',
    'section',
    'table',
    'ul',
  ];
  if (blockLevelTags.find((i) => i === tagName.trim().toLowerCase())) {
    return true;
  }
  return false;
}

/**
 * Causes a compile-time error if we got to a point in the code that we don't expect to reach, but doesn't throw a
 * runtime error. It returns the second argument.
 */
export function assertUnreachableButStillReturn<T>(_x: never, defaultToReturn: T): T {
  return defaultToReturn;
}

export function isUrlString(inputData: unknown): inputData is string {
  if (typeof inputData === 'string') {
    try {
      new URL(inputData);
    } catch {
      return false;
    }
    return true;
  }
  return false;
}
