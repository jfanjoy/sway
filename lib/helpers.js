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

'use strict'

const jsf = require('json-schema-faker')
const formatGenerators = require('./validation/format-generators')
const formatValidators = require('./validation/format-validators')
const ZSchema = require('z-schema')

// a few helpers to get rid of lodash
const isPlainObject = function (o) {
  return Object.prototype.toString.call(o) === '[object Object]'
}

// full-date from http://xml2rfc.ietf.org/public/rfc/html/rfc3339.html#anchor14
const dateRegExp = new RegExp(
  '^' +
  '\\d{4}' + // year
  '-' +
  '([0]\\d|1[012])' + // month
  '-' +
  '(0[1-9]|[12]\\d|3[01])' + // day
  '$')

// date-time from http://xml2rfc.ietf.org/public/rfc/html/rfc3339.html#anchor14
const dateTimeRegExp = new RegExp(
  '^' +
  '\\d{4}' + // year
  '-' +
  '([0]\\d|1[012])' + // month
  '-' +
  '(0[1-9]|[12]\\d|3[01])' + // day
  'T' +
  '([01]\\d|2[0-3])' + // hour
  ':' +
  '[0-5]\\d' + // minute
  ':' +
  '[0-5]\\d' + // second
  '(\\.\\d+)?' + // fractional seconds
  '(Z|(\\+|-)([01]\\d|2[0-4]):[0-5]\\d)' + // Z or time offset
  '$')

const collectionFormats = [undefined, 'csv', 'multi', 'pipes', 'ssv', 'tsv']
let jsonMocker
const jsonSchemaValidator = createJSONValidator()
// https://github.com/OAI/OpenAPI-Specification/blob/master/versions/3.0.0.md#parameterObject
const parameterSchemaProperties = [
  'allowEmptyValue',
  'default',
  'description',
  'enum',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'items',
  'maxItems',
  'maxLength',
  'maximum',
  'minItems',
  'minLength',
  'minimum',
  'multipleOf',
  'pattern',
  'type',
  'uniqueItems'
]
const types = ['array', 'boolean', 'integer', 'object', 'number', 'string']

function createJSONMocker () {
  // Add the custom format generators
  formatGenerators.forEach(function (gen, name) {
    jsf.format(name, gen(jsf))
  })

  return jsf
}

function findExtraParameters (expected, actual, location, results) {
  let codeSuffix = location.toUpperCase()

  switch (location) {
    case 'formData':
      codeSuffix = 'FORM_DATA'
      location = 'form data field'
      break
    case 'query':
      location = 'query parameter'
      break

    // no default
  }

  actual.forEach(function (name) {
    if (expected.indexOf(name) === -1) {
      results.errors.push({
        code: 'REQUEST_ADDITIONAL_' + codeSuffix,
        message: 'Additional ' + location + ' not allowed: ' + name,
        path: []
      })
    }
  })
}

function registerFormat (name, validator) {
  ZSchema.registerFormat(name, validator)
}

function registerFormatGenerator (name, func) {
  getJSONSchemaMocker().format(name, func)
}

function unregisterFormat (name) {
  ZSchema.unregisterFormat(name)
}

function unregisterFormatGenerator (name) {
  delete getJSONSchemaMocker().format()[name]
}

function createJSONValidator () {
  const validator = ZSchema.create({
    breakOnFirstError: false,
    ignoreUnknownFormats: true,
    reportPathAsArray: true
  })

  // Add the custom validators
  formatValidators.each(function (handler, name) {
    registerFormat(name, handler)
  })

  return validator
}

function getJSONSchemaMocker () {
  if (!jsonMocker) {
    jsonMocker = createJSONMocker(jsf)
  }

  return jsonMocker
};

function normalizeError (obj) {
  // Remove superfluous error details
  if (typeof obj.schemaId === 'undefined') {
    delete obj.schemaId
  }

  if (obj.inner) {
    obj.inner.each(function (nObj) {
      normalizeError(nObj)
    })
  }
}

// simple object check
module.exports.isPlainObject = isPlainObject
/**
 * Helper method to take an OpenAPI Parameter Object definition and compute its schema.
 *
 * For non-body OpenAPI parameters, the definition itself is not suitable as a JSON Schema so we must compute it.
 *
 * @param {object} paramDef - The parameter definition
 *
 * @returns {object} The computed schema
 */
module.exports.computeParameterSchema = function (paramDef) {
  let schema

  if (!paramDef?.schema) {
    schema = {}
    for (const name of parameterSchemaProperties) {
      if (typeof paramDef[name] !== 'undefined') Object.assign(schema, { [name]: paramDef[name] })
    }
  } else {
    schema = paramDef.schema
  }

  return schema
}

/**
 * Converts a raw JavaScript value to a JSON Schema value based on its schema.
 *
 * @param {object} schema - The schema for the value
 * @param {object} options - The conversion options
 * @param {string} [options.collectionFormat] - The collection format
 * @param {string} [options.encoding] - The encoding if the raw value is a `Buffer`
 * @param {*} value - The value to convert
 *
 * @returns {*} The converted value
 *
 * @throws {TypeError} IF the `collectionFormat` or `type` is invalid for the `schema`, or if conversion fails
 */
const convertValue = module.exports.convertValue = function (schema, options, value) {
  const originalValue = value // Used in error reporting for invalid values
  const type = isPlainObject(schema) ? schema.type : undefined
  let pValue = value
  let pType = typeof pValue
  let err
  let isDate
  let isDateTime

  // If there is an explicit type provided, make sure it's one of the supported ones
  if (type && types.indexOf(type) === -1) {
    throw new TypeError('Invalid \'type\' value: ' + type)
  }

  // Since JSON Schema allows you to not specify a type and it is treated as a wildcard of sorts, we should not do any
  // coercion for these types of values.
  if (!type) {
    return value
  }

  // If there is no value, do not convert it
  if (typeof value === 'undefined') {
    return value
  }

  // Convert Buffer value to String
  // simplified to only support node moving forward since we never use this in the browser
  if (Buffer.isBuffer(value)) {
    value = value.toString(options.encoding)
    pValue = value
    pType = typeof value
  }

  // If the value is empty and empty is allowed, use it
  if (schema.allowEmptyValue && value === '') {
    return value
  }

  // Attempt to parse the string as JSON if the type is array or object
  if (['array', 'object'].indexOf(type) > -1 && typeof value === 'string') {
    if ((type === 'array' && value.indexOf('[') === 0) || (type === 'object' && value.indexOf('{') === 0)) {
      try {
        value = JSON.parse(value)
      } catch (err) {
        // Nothing to do here, just fall through
      }
    }
  }

  switch (type) {
    case 'array':
      if (typeof value === 'string') {
        if (collectionFormats.indexOf(options.collectionFormat) === -1) {
          throw new TypeError('Invalid \'collectionFormat\' value: ' + options.collectionFormat)
        }

        switch (options.collectionFormat) {
          case 'csv':
          case undefined:
            value = value.split(',')
            break
          case 'multi':
            value = [value]
            break
          case 'pipes':
            value = value.split('|')
            break
          case 'ssv':
            value = value.split(' ')
            break
          case 'tsv':
            value = value.split('\t')
            break

        // no default
        }
      }

      if (Array.isArray(value)) {
        value = value.map(function (item, index) {
          return convertValue(Array.isArray(schema.items) ? schema.items[index] : schema.items, options, item)
        })
      }

      break
    case 'boolean':
      if (typeof value !== 'boolean') {
        value = (value === 'true')
      }

      break
    case 'integer':
      value = parseInt(value)
      if (Number.isNaN(value)) {
        err = new TypeError('Not a valid integer: ' + originalValue)
      }
      break
    case 'number':
      // might be a float
      value = parseFloat(value)
      if (Number.isNaN(value)) {
        err = new TypeError('Not a valid integer: ' + originalValue)
      }
      break
    case 'string':
      if (['date', 'date-time'].indexOf(schema.format) > -1) {
        if (typeof value === 'string') {
          isDate = schema.format === 'date' && dateRegExp.test(value)
          isDateTime = schema.format === 'date-time' && dateTimeRegExp.test(value)

          if (!isDate && !isDateTime) {
            err = new TypeError('Not a valid ' + schema.format + ' string: ' + originalValue)
            err.code = 'INVALID_FORMAT'
          } else {
            value = new Date(value)
          }
        }
        if (!(value instanceof Date) || value.toString() === 'Invalid Date') {
          err = new TypeError('Not a valid ' + schema.format + ' string: ' + originalValue)
          err.code = 'INVALID_FORMAT'
        }
      } else if (typeof value !== 'string') {
        err = new TypeError('Not a valid string: ' + value)
      }

      break

    // no default
  }

  if (typeof err !== 'undefined') {
    // Convert the error to be more like a JSON Schema validation error
    if (!err?.code) {
      err.code = 'INVALID_TYPE'
      err.message = 'Expected type ' + type + ' but found type ' + pType
    } else {
      err.message = 'Object didn\'t pass validation for format ' + schema.format + ': ' + pValue
    }

    // Format and type errors resemble JSON Schema validation errors
    err.failedValidation = true
    err.path = []

    throw err
  }

  return value
}

/**
 * Returns the provided content type or `application/octet-stream` if one is not provided.
 *
 * @see http://www.w3.org/Protocols/rfc2616/rfc2616-sec7.html#sec7.2.1
 *
 * @param {object} headers - The headers to search
 *
 * @returns {string} The content type
 */
module.exports.getContentType = function (headers) {
  return getHeaderValue(headers, 'content-type')
}

/**
 * Returns the header value regardless of the case of the provided/requested header name.
 *
 * @param {object} headers - The headers to search
 * @param {string} headerName - The header name
 *
 * @returns {string} The header value or `undefined` if it is not found
 */
const getHeaderValue = module.exports.getHeaderValue = function (headers, headerName) {
  // Default to an empty object
  headers = headers || {}

  const lcHeaderName = headerName.toLowerCase()
  const realHeaderName = Object.keys(headers).find(function (header) {
    return header.toLowerCase() === lcHeaderName
  })

  return headers[realHeaderName]
}

/**
 * Returns a json-schema-faker mocker.
 *
 * @returns {object} The json-schema-faker mocker to use
 */
module.exports.getJSONSchemaMocker = getJSONSchemaMocker

module.exports.getSample = function (schema) {
  let sample

  if (typeof schema !== 'undefined') {
    if (schema.type === 'file') {
      sample = 'This is sample content for the "file" type.'
    } else {
      sample = getJSONSchemaMocker().generate(schema)
    }
  }

  return sample
}

/**
 * Returns a z-schema validator.
 *
 * @returns {object} The z-schema validator to use
 */
module.exports.getJSONSchemaValidator = function () {
  return jsonSchemaValidator
}

module.exports.parameterLocations = ['body', 'formData', 'header', 'path', 'query']

/**
 * Process validators.
 *
 * @param {object|module:Sway~ServerResponseWrapper} target - The thing being validated
 * @param {module:Sway~ApiDefinition|module:Sway~Operation|module:Sway~Response} caller - The object requesting validation _(can be `undefined`)_
 * @param {module:Sway~DocumentValidationFunction[]|module:Sway~RequestValidationFunction[]|module:Sway~ResposeValidationFunction[]} validators - The validators
 * @param {module:Sway~ValidationResults} results - The cumulative validation results
 */
module.exports.processValidators = function (target, caller, validators, results) {
  validators.forEach(function (validator) {
    const vArgs = [target]

    if (typeof caller !== 'undefined') {
      vArgs.push(caller)
    }

    const vResults = validator.apply(undefined, vArgs)

    if (vResults?.errors?.length) {
      results.errors.push.apply(results.errors, vResults.errors)
    }
    if (vResults?.warnings?.length) {
      results.warnings.push.apply(results.warnings, vResults.warnings)
    }
  })
}

function normalizePath (path) {
  if (Array.isArray(path)) return path.map(k => k.toString())
  if (typeof path === 'string') return path === '' ? [] : path.split('.')
  return [path.toString()]
}

const isObject = (o) => (!Array.isArray(o) && typeof o === 'object' && o !== null)
const isArrayIdx = (k) => (typeof k === 'string' && /^0$|[1-9]\d*$/.test(k))
const isFunction = (f) => (typeof f?.call === 'function')

// vanilla logic to replace some stuff needed in lodash
function get (o, p) {
  try {
    const [first, ...rem] = p.split('.')
    const extractor = /(?<prop>[^[]+)(\[(?<ind>\d+)\])?/
    let f = {}
    if (!rem.length && (first in o)) {
      // path is direct
      f = o[first]
    } else {
      // we need to check for the existence of '[]' in the first object
      // and if it exists we need to extract the index and property name separately
      const match = extractor.exec(first)
      if (match?.groups?.prop) {
        const lobj = o[match.groups.prop]
        if (match?.groups?.ind in lobj) {
          Object.assign(f, lobj[match.groups?.ind])
        } else if (!match?.groups?.ind) {
          Object.assign(f, lobj)
        }
      } else {
        return undefined
      }
      if (typeof f === 'object') {
        // check if first is an array element
        // check if o.first is an object
        while (rem.length) {
          const next = rem.shift()
          const match = extractor.exec(next)
          if (!match) { return undefined }
          const { ind, prop } = match.groups
          if (!(prop in f)) { return undefined }
          const lprop = f[prop]
          if (ind && ind in lprop) {
            f = lprop[ind]
          } else if (prop in f && !ind) {
            f = lprop
          } else {
            return undefined
          }
        }
      }
    }
    return f
  } catch (err) {
    console.warn(err)
  }
}

function set (obj, path, value) {
  const normalizedPath = normalizePath(path)
  let target = isObject(obj) ? obj : {}
  const lastIdx = normalizedPath.length - 1
  for (const [i, part] in normalizedPath) {
    if (i >= lastIdx) break // stop before we reach the end
    const key = part
    const next = normalizedPath[i + 1]
    let current = target[key]
    if (!isObject(current)) {
      current = isArrayIdx(next) ? [] : {}
      target[key] = current
    }
    target = current
  }
  const key = normalizedPath[lastIdx]
  target[key] = value
  return isObject(obj) ? obj : target
}

function has (o, p) {
  const v = get(o, p)
  return !!v
}

module.exports.isObject = isObject
module.exports.isFunction = isFunction
module.exports.get = get
module.exports.set = set
module.exports.has = has

/**
 * Registers a custom format.
 *
 * @param {string} name - The name of the format
 * @param {function} validator - The format validator *(See [ZSchema Custom Format](https://github.com/zaggino/z-schema#register-a-custom-format))*
 */
module.exports.registerFormat = registerFormat

/**
 * Registers a custom format generator.
 *
 * @param {string} name - The name of the format
 * @param {function} generator - The format generator *(See [json-schema-mocker Custom Format](https://github.com/json-schema-faker/json-schema-faker#custom-formats))*
 */
module.exports.registerFormatGenerator = registerFormatGenerator

/**
 * Replaces the circular references in the provided object with an empty object.
 *
 * @param {object} obj - The JavaScript object
 */
module.exports.removeCirculars = function (obj) {
  walk(obj, function (node, path, ancestors) {
    // Replace circulars with {}
    if (ancestors.indexOf(node) > -1) {
      set(obj, path, {})
    }
  })
}

/**
 * Unregisters a custom format.
 *
 * @param {string} name - The name of the format
 */
module.exports.unregisterFormat = unregisterFormat

/**
 * Unregisters a custom format generator.
 *
 * @param {string} name - The name of the format generator
 */
module.exports.unregisterFormatGenerator = unregisterFormatGenerator

/**
 * Validates the provided value against the JSON Schema by name or value.
 *
 * @param {object} validator - The JSON Schema validator created via {@link #createJSONValidator}
 * @param {object} schema - The JSON Schema
 * @param {*} value - The value to validate
 *
 * @returns {object} Object containing the errors and warnings of the validation
 */
module.exports.validateAgainstSchema = function (validator, inputSchema, value) {
  const schema = structuredClone(inputSchema) // Clone the schema as z-schema alters the provided document

  const response = {
    errors: [],
    warnings: []
  }

  if (!validator.validate(value, schema)) {
    response.errors = validator.getLastErrors().map(function (err) {
      normalizeError(err)

      return err
    })
  }

  return response
}

/**
 * Validates the content type.
 *
 * @param {string} contentType - The Content-Type value of the request/response
 * @param {string[]} supportedTypes - The supported (declared) Content-Type values for the request/response
 * @param {object} results - The results object to update in the event of an invalid content type
 */
module.exports.validateContentType = function (contentType, supportedTypes, results) {
  const rawContentType = contentType

  if (typeof contentType !== 'undefined') {
    // http://www.w3.org/Protocols/rfc2616/rfc2616-sec14.html#sec14.17
    contentType = contentType.split(';')[0] // Strip the parameter(s) from the content type
  }

  // Check for exact match or mime-type only match
  if (supportedTypes.indexOf(rawContentType) === -1 && supportedTypes.indexOf(contentType) === -1) {
    results.errors.push({
      code: 'INVALID_CONTENT_TYPE',
      message: 'Invalid Content-Type (' + contentType + ').  These are supported: ' +
        supportedTypes.join(', '),
      path: []
    })
  }
}

/**
 * Walk an object and invoke the provided function for each node.
 *
 * @param {*} obj - The object to walk
 * @param {function} [fn] - The function to invoke
 */
const walk = module.exports.walk = function (obj, fn) {
  const callFn = isFunction(fn)

  function doWalk (ancestors, node, path) {
    if (callFn) {
      fn(node, path, ancestors)
    }

    // We do not process circular objects again
    if (ancestors.indexOf(node) === -1) {
      ancestors.push(node)

      if (Array.isArray(node) || isPlainObject(node)) {
        node.forEach(function (member, indexOrKey) {
          doWalk(ancestors, member, path.concat(indexOrKey.toString()))
        })
      }
    }

    ancestors.pop()
  }

  doWalk([], obj, [])
}

/**
 * Validates that each item in the array are of type function.
 *
 * @param {array} arr - The array
 * @param {string} paramName - The parameter name
 */
module.exports.validateOptionsAllAreFunctions = function (arr, paramName) {
  arr.forEach(function (item, index) {
    if (!isFunction(item)) {
      throw new TypeError('options.' + paramName + ' at index ' + index + ' must be a function')
    }
  })
}

/**
 * Validates the request/response strictly based on the provided options.
 *
 * @param {module:Sway~Operation|module:Sway~Response} opOrRes - The Sway operation or response
 * @param {object|module:Sway~ServerResponseWrapper} reqOrRes - The http client request *(or equivalent)* or the
 *                                                              response or *(response like object)*
 * @param {object} strictMode - The options for configuring strict mode
 * @param {boolean} options.formData - Whether or not form data parameters should be validated strictly
 * @param {boolean} options.header - Whether or not header parameters should be validated strictly
 * @param {boolean} options.query - Whether or not query parameters should be validated strictly
 * @param {module:Sway~ValidationResults} results - The validation results
 */
module.exports.validateStrictMode = function (opOrRes, reqOrRes, strictMode, results) {
  const definedParameters = {
    formData: [],
    header: [],
    query: []
  }
  const mode = opOrRes.constructor.name === 'Operation' ? 'req' : 'res'
  const strictModeValidation = {
    formData: false,
    header: false,
    query: false
  }

  if (typeof strictMode !== 'undefined') {
    if (typeof strictMode !== 'boolean' && !isPlainObject(strictMode)) {
      throw new TypeError('options.strictMode must be a boolean or an object')
    } else if (isPlainObject(strictMode)) {
      ['formData', 'header', 'query'].forEach(function (location) {
        if (location in strictMode && typeof strictMode[location] === 'boolean') {
          strictModeValidation[location] = strictMode[location]
        } else {
          throw new TypeError('options.strictMode.' + location + ' must be a boolean')
        }
      })
    } else if (strictMode === true) {
      strictModeValidation.formData = true
      strictModeValidation.header = true
      strictModeValidation.query = true
    }
  }

  // Only process the parameters if necessary
  if (strictModeValidation.formData === true ||
      strictModeValidation.header === true ||
      strictModeValidation.query === true) {
    const target = (mode === 'req') ? opOrRes : opOrRes.operationObject
    target.getParameters().forEach(function (parameter) {
      if (Array.isArray(definedParameters[parameter.in])) {
        definedParameters[parameter.in].push(parameter.name)
      }
    })
  }

  // Validating form data only matters for requests
  if (strictModeValidation.formData === true && mode === 'req') {
    findExtraParameters(definedParameters.formData,
      isPlainObject(reqOrRes.body) ? Object.keys(reqOrRes.body) : [],
      'formData',
      results)
  }

  // Always validate the headers for requests and responses
  if (strictModeValidation.header === true) {
    findExtraParameters(definedParameters.header,
      isPlainObject(reqOrRes.headers) ? Object.keys(reqOrRes.headers) : [],
      'header',
      results)
  }

  // Validating the query string only matters for requests
  if (strictModeValidation.query === true && mode === 'req') {
    findExtraParameters(definedParameters.query,
      isPlainObject(reqOrRes.query) ? Object.keys(reqOrRes.query) : [],
      'query',
      results)
  }
}
