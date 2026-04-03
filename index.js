'use strict'
/*
 * The MIT License (MIT)
 *
 * Copyright (c) 2015 Apigee Corporation
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

const helpers = require('./lib/helpers')
const JsonRefs = require('json-refs')
const ApiDefinition = require('./lib/types/api-definition')
const YAML = require('js-yaml')

/**
 * A library that simplifies [OpenAPI](https://www.openapis.org/) integrations.
 *
 * @module sway
 */

/**
 * Creates an ApiDefinition object from the provided OpenAPI definition.
 *
 * @param {module:sway.CreateOptions} options - The options for loading the definition(s)
 *
 * @returns {Promise<module:sway.ApiDefinition>} The promise
 *
 * @example
 * Sway.create({
 *   definition: 'https://raw.githubusercontent.com/OAI/OpenAPI-Specification/master/examples/v3.0/petstore.yaml'
 * })
 * .then(function (apiDefinition) {
 *   console.log('Documentation URL: ', apiDefinition.documentationUrl);
 * }, function (err) {
 *   console.error(err.stack);
 * });
 */
module.exports.create = async function (options) {
  const defaultOptions = {
    jsonRefs: {
      includeInvalid: true,
      filter: ['relative', 'remote'],
      loaderOptions: {
        processContent: function (res, cb) {
          cb(undefined, YAML.safeLoad(res.text))
        }
      }
    }
  }
  if (!options) throw new TypeError('options is a required parameter')
  if (!options?.definition ||
    (!helpers.isPlainObject(options.definition) &&
    typeof options?.definition !== 'string')) throw new TypeError('definitions property missing from options')
  if (!options?.customFormats || !Array.isArray(options.customFormats)) throw new TypeError('an array of custom formats is required')
  if (!options?.customFormatGenerators || !Array.isArray(options.customFormatGenerators)) throw new TypeError('an array of custom formats is required')
  if (!options?.customValidators || !Array.isArray(options.customValidators)) throw new TypeError('an array of custom validators is required')

  helpers.validateOptionsAllAreFunctions(options.customFormats, 'customFormats')
  helpers.validateOptionsAllAreFunctions(options.customFormatGenerators, 'customFormatGenerators')
  helpers.validateOptionsAllAreFunctions(options.customValidators, 'customValidators')

  // Make a copy of the input options so as not to alter them
  const cOptions = Object.assign({}, defaultOptions, options)

  const remoteResults = (typeof cOptions.definition === 'string')
  // Call the appropriate json-refs API
    ? JsonRefs.resolveRefsAt(cOptions.definition, cOptions.jsonRefs)
    : JsonRefs.resolveRefs(cOptions.definition, cOptions.jsonRefs)
    // Resolve local references and merge results
  // Resolve local references (Remote references should had already been resolved)
  cOptions.jsonRefs.filter = 'local'

  const results = JsonRefs.resolveRefs(remoteResults.resolved || cOptions.definition, cOptions.jsonRefs)
    .then(function (results) {
      for (const [refPtr, refDetails] in remoteResults.refs) results.refs[refPtr] = refDetails
      return {
        // The original OpenAPI definition
        definition: typeof cOptions.definition === 'string' ? remoteResults.value : cOptions.definition,
        // The original OpenAPI definition with its remote references resolved
        definitionRemotesResolved: remoteResults.resolved,
        // The original OpenAPI definition with all its references resolved
        definitionFullyResolved: results.resolved,
        // Merge the local reference details with the remote reference details
        refs: results.refs
      }
    })
    // Process the OpenAPI document and return an ApiDefinition
  // We need to remove all circular objects as z-schema does not work with them:
  //   https://github.com/zaggino/z-schema/issues/137
  helpers.removeCirculars(results.definition)
  helpers.removeCirculars(results.definitionRemotesResolved)
  helpers.removeCirculars(results.definitionFullyResolved)

  // Create object model
  const finalResult = new ApiDefinition(results.definition,
    results.definitionRemotesResolved,
    results.definitionFullyResolved,
    results.refs,
    options)

  return finalResult
}
