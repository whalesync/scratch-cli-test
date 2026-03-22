// Borrowed from:
// https://github.com/douglascrockford/JSON-js/blob/8e8b0407e475e35942f7e9461dab81929fcc7321/cycle.js#L1

/*
    cycle.js
    2021-05-31
    Public Domain.
    NO WARRANTY EXPRESSED OR IMPLIED. USE AT YOUR OWN RISK.
    This code should be minified before deployment.
    See https://www.crockford.com/jsmin.html
    USE YOUR OWN COPY. IT IS EXTREMELY UNWISE TO LOAD CODE FROM SERVERS YOU DO
    NOT CONTROL.
*/

// The file uses the WeakMap feature of ES6.

/*jslint eval */

/*property
    $ref, decycle, forEach, get, indexOf, isArray, keys, length, push,
    retrocycle, set, stringify, test
*/

export class JsonCycle {
  static safeStringify(object: unknown): string {
    return JSON.stringify(JsonCycle.decycle(object));
  }

  static decycle(object: unknown, replacer?: (value: unknown) => unknown): unknown {
    'use strict';

    // Make a deep copy of an object or array, assuring that there is at most
    // one instance of each object or array in the resulting structure. The
    // duplicate references (which might be forming cycles) are replaced with
    // an object of the form

    //      {"$ref": PATH}

    // where the PATH is a JSONPath string that locates the first occurance.

    // So,

    //      var a = [];
    //      a[0] = a;
    //      return JSON.stringify(JSON.decycle(a));

    // produces the string '[{"$ref":"$"}]'.

    // If a replacer function is provided, then it will be called for each value.
    // A replacer function receives a value and returns a replacement value.

    // JSONPath is used to locate the unique object. $ indicates the top level of
    // the object or array. [NUMBER] or [STRING] indicates a child element or
    // property.

    const objects = new WeakMap(); // object to path mappings

    return (function derez(value: unknown, path: string): unknown {
      // The derez function recurses through the object, producing the deep copy.

      let old_path: string | undefined; // The path of an earlier occurance of value
      let nu: unknown[] | Record<string, unknown>; // The new object or array

      // If a replacer function was provided, then call it to get a replacement value.

      if (replacer !== undefined) {
        value = replacer(value);
      }

      // typeof null === "object", so go on if this value is really an object but not
      // one of the weird builtin objects.

      if (
        typeof value === 'object' &&
        value !== null &&
        !(value instanceof Boolean) &&
        !(value instanceof Date) &&
        !(value instanceof Number) &&
        !(value instanceof RegExp) &&
        !(value instanceof String)
      ) {
        // If the value is an object or array, look to see if we have already
        // encountered it. If so, return a {"$ref":PATH} object. This uses an
        // ES6 WeakMap.

        old_path = objects.get(value) as string | undefined;
        if (old_path !== undefined) {
          return { $ref: old_path };
        }

        // Otherwise, accumulate the unique value and its path.

        objects.set(value, path);

        // If it is an array, replicate the array.

        if (Array.isArray(value)) {
          nu = [] as unknown[];
          value.forEach(function (element: unknown, i: number) {
            (nu as unknown[])[i] = derez(element, path + '[' + i + ']');
          });
        } else {
          // If it is an object, replicate the object.

          nu = {} as Record<string, unknown>;
          const obj = value as Record<string, unknown>;
          Object.keys(obj).forEach(function (name: string) {
            (nu as Record<string, unknown>)[name] = derez(obj[name], path + '[' + JSON.stringify(name) + ']');
          });
        }
        return nu;
      }
      return value;
    })(object, '$');
  }

  static retrocycle($: unknown): unknown {
    'use strict';

    // Restore an object that was reduced by decycle. Members whose values are
    // objects of the form
    //      {$ref: PATH}
    // are replaced with references to the value found by the PATH. This will
    // restore cycles. The object will be mutated.

    // The eval function is used to locate the values described by a PATH. The
    // root object is kept in a $ variable. A regular expression is used to
    // assure that the PATH is extremely well formed. The regexp contains nested
    // * quantifiers. That has been known to have extremely bad performance
    // problems on some browsers for very long strings. A PATH is expected to be
    // reasonably short. A PATH is allowed to belong to a very restricted subset of
    // Goessner's JSONPath.

    // So,
    //      var s = '[{"$ref":"$"}]';
    //      return JSON.retrocycle(JSON.parse(s));
    // produces an array containing a single element which is the array itself.

    // eslint-disable-next-line no-control-regex, no-useless-escape -- Crockford's original regex
    const px = /^\$(?:\[(?:\d+|"(?:[^\\"\u0000-\u001f]|\\(?:[\\"\/bfnrt]|u[0-9a-zA-Z]{4}))*")\])*$/;

    (function rez(value: unknown): void {
      // The rez function walks recursively through the object looking for $ref
      // properties. When it finds one that has a value that is a path, then it
      // replaces the $ref object with a reference to the value that is found by
      // the path.

      if (value && typeof value === 'object') {
        if (Array.isArray(value)) {
          value.forEach(function (element: unknown, i: number) {
            if (typeof element === 'object' && element !== null) {
              const path = (element as Record<string, unknown>).$ref;
              if (typeof path === 'string' && px.test(path)) {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- eval returns any
                value[i] = eval(path);
              } else {
                rez(element);
              }
            }
          });
        } else {
          const obj = value as Record<string, unknown>;
          Object.keys(obj).forEach(function (name: string) {
            const item = obj[name];
            if (typeof item === 'object' && item !== null) {
              const path = (item as Record<string, unknown>).$ref;
              if (typeof path === 'string' && px.test(path)) {
                obj[name] = eval(path);
              } else {
                rez(item);
              }
            }
          });
        }
      }
    })($);
    return $;
  }
}
