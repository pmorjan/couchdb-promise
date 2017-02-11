// http://docs.couchdb.org/en/stable/api/index.html
'use strict'
const assert = require('assert')
const http = require('http')
const https = require('https')
const querystring = require('querystring')
const urlParse = require('url').parse

// https://wiki.apache.org/couchdb/HTTP_view_API#Querying_Options
const QUERY_KEYS_JSON = ['key', 'keys', 'startkey', 'endkey']

module.exports = function (opt) {
  const config = {
    requestTimeout: 10000, // ms
    verifyCertificate: true
  }
  Object.assign(config, opt)

  if (typeof config.baseUrl === 'undefined') {
    throw new Error('missing property "baseUrl"')
  }

  const o = urlParse(config.baseUrl)
  if (!(
    ['http:', 'https:'].indexOf(o.protocol) >= 0 &&
    o.slashes === true &&
    !Number.isNaN(parseInt(o.port, 10)) &&
    o.hostname)
  ) throw new Error('invalid baseUrl')

  const httpOptions = {
    hostname: o.host && o.host.split(':')[0],
    port: o.port,
    auth: o.auth,
    protocol: o.protocol,
    rejectUnauthorized: config.verifyCertificate,
    headers: {
      'user-agent': 'couchdb-promises',
      accept: 'application/json'
    }
  }

  function createQueryString (queryObj) {
    const obj = Object.assign({}, queryObj)
    QUERY_KEYS_JSON.forEach(key => {
      if (key in obj) {
        obj[key] = JSON.stringify(obj[key])
      }
    })
    return Object.keys(obj).length ? `?${querystring.stringify(obj)}` : ''
  }

  function statusCode (statusCodes, status) {
    const codes = Object.assign({}, http.STATUS_CODES, statusCodes)
    return codes[status] || 'unknown status'
  }

  function request (param) {
    const t0 = Date.now()

    httpOptions.method = param.method
    httpOptions.path = '/' + param.path

    const statusCodes = param.statusCodes
    const postData = param.postData
    const postContentType = param.postContentType

    // If passed, propagate Destination header required for HTTP COPY
    if (param.headers && param.headers.Destination) {
      httpOptions.headers.Destination = param.headers.Destination
    }

    let body
    let stream
    let error

    if (Buffer.isBuffer(postData)) {
      //
      // buffer
      //
      body = postData
      httpOptions.headers['content-type'] = postContentType
      httpOptions.headers['content-length'] = Buffer.byteLength(postData)
    } else if (postData && postData.readable && typeof postData._read === 'function') {
      //
      // stream
      //
      httpOptions.headers['content-type'] = postContentType
      httpOptions.headers['Transfer-Encoding'] = 'chunked'
      stream = postData
    } else if (Object.prototype.toString.call(postData) === '[object Object]') {
      //
      // regular object -> JSON
      //
      try {
        body = JSON.stringify(postData)
      } catch (err) {
        error = err
      }
      httpOptions.headers['content-type'] = 'application/json'
      httpOptions.headers['content-length'] = Buffer.byteLength(body)
    } else if (typeof postData === 'string') {
      //
      // string
      //
      body = postData
      httpOptions.headers['content-type'] = postContentType
      httpOptions.headers['content-length'] = body.length
    } else if (postData || postData === null) {
      error = 'unsupported post data'
    }

    if (error) {
      return Promise.reject({
        headers: {},
        data: {error: error},
        status: 400,
        message: 'invalid post data',
        duration: Date.now() - t0
      })
    }

    return new Promise(function (resolve, reject) {
      const lib = httpOptions.protocol === 'https:' ? https : http
      const req = lib.request(httpOptions, function (res) {
        let buffer = ''
        res.setEncoding('utf8')
        res.on('data', function (data) {
          buffer += data
        })
        res.on('end', function () {
          let ret
          try {
            ret = {
              headers: res.headers,
              data: JSON.parse(buffer || '{}'),
              status: res.statusCode,
              message: statusCode(statusCodes, res.statusCode),
              duration: Date.now() - t0
            }
          } catch (err) {
            ret = {
              headers: res.headers,
              data: {error: err.message},
              status: 500,
              message: err.message || 'internal error',
              duration: Date.now() - t0
            }
          }

          if (ret.status < 400) {
            return resolve(ret)
          } else {
            return reject(ret)
          }
        })
      })

      req.setTimeout(config.requestTimeout, function () {
        req.abort()
        reject({
          headers: {},
          data: {error: 'request timed out'},
          status: 500,
          message: 'Error: request timed out',
          duration: Date.now() - t0
        })
      })

      req.on('error', function (err) {
        reject({
          headers: {},
          data: {error: err},
          status: 500,
          message: err.message || 'internal error',
          duration: Date.now() - t0
        })
      })

      if (body) {
        req.write(body)
        req.end()
      } else if (stream) {
        stream.on('data', function (chunk) {
          req.write(chunk)
        })
        stream.on('end', function () {
          req.end()
        })
      } else {
        req.end()
      }
    })
  }

  function requestStream (param) {
    const t0 = Date.now()

    const statusCodes = param.statusCodes
    const stream = param.stream

    assert(stream && stream.writable && typeof stream.pipe === 'function', 'is writeable stream')

    httpOptions.method = 'GET'
    httpOptions.path = '/' + param.path

    return new Promise(function (resolve, reject) {
      const lib = httpOptions.protocol === 'https:' ? https : http
      const req = lib.request(httpOptions, function (res) {
        res.pipe(stream)
        const ret = {
          headers: res.headers,
          status: res.statusCode,
          message: statusCode(statusCodes, res.statusCode),
          duration: Date.now() - t0
        }

        if (ret.status < 400) {
          return resolve(ret)
        } else {
          return reject(ret)
        }
      })

      req.setTimeout(config.requestTimeout, function () {
        req.abort()
        reject({
          headers: {},
          data: {error: 'request timed out'},
          status: 500,
          message: 'Error: request timed out',
          duration: Date.now() - t0
        })
      })

      req.on('error', function (err) {
        reject({
          headers: {},
          data: {error: err},
          status: 500,
          message: err.message || 'internal error',
          duration: Date.now() - t0
        })
      })

      req.end()
    })
  }

  const couch = {}

  /**
   * All promisses are settled  with an object with the folloing properties
   *  headers: {Object} - response headers
   *  data:  {Object} - response body from the database server
   *  status: {Number} - http status code
   *  message: {String} - http message
   */

  /**
   * Get server info
   * @return {Promise}
   */
  couch.getInfo = function getInfo () {
    return request({
      path: '',
      method: 'GET',
      statusCodes: {
        200: 'OK - Request completed successfully'
      }
    })
  }

  /**
   * Get the list of all databases.
   * @return {Promise}
   */
  couch.listDatabases = function listDatabases () {
    return request({
      path: '_all_dbs',
      method: 'GET',
      statusCodes: {
        200: 'OK - Request completed successfully'
      }
    })
  }

  /**
   * Create database
   * @param  {String} dbName
   * @return {Promise}
   */
  couch.createDatabase = function createDatabase (dbName) {
    return request({
      path: encodeURIComponent(dbName),
      method: 'PUT',
      statusCodes: {
        201: 'Created - Database created successfully',
        400: 'Bad Request - Invalid database name',
        401: 'Unauthorized - CouchDB Server Administrator privileges required',
        412: 'Precondition Failed - Database already exists'
      }
    })
  }

  /**
   * Get database
   * @param  {String} dbName
   * @return {Promise}
   */
  couch.getDatabase = function getDatabase (dbName) {
    return request({
      path: encodeURIComponent(dbName),
      method: 'GET',
      statusCodes: {
        200: 'OK - Request completed successfully',
        404: 'Not Found – Requested database not found'
      }
    })
  }

  /**
   * Get database head
   * @param  {String} dbName
   * @return {Promise}
   */
  couch.getDatabaseHead = function getDatabaseHead (dbName) {
    return request({
      path: encodeURIComponent(dbName),
      method: 'HEAD',
      statusCodes: {
        200: 'OK - Database exists',
        404: 'Not Found – Requested database not found'
      }
    })
  }

  /**
   * Delete database
   * @param  {String} dbName
   * @return {Promise}
   */
  couch.deleteDatabase = function deleteDatabase (dbName) {
    return request({
      path: encodeURIComponent(dbName),
      method: 'DELETE',
      statusCodes: {
        200: 'OK - Database removed successfully',
        400: 'Bad Request - Invalid database name or forgotten document id by accident',
        401: 'Unauthorized - CouchDB Server Administrator privileges required',
        404: 'Not Found - Database doesn’t exist'
      }
    })
  }

  /**
   * Get all documents
   * @param  {String} dbName
   * @param  {Object} [query]
   * @return {Promise}
   */
  couch.getAllDocuments = function getAllDocuments (dbName, queryObj) {
    const queryStr = createQueryString(queryObj)
    return request({
      path: `${encodeURIComponent(dbName)}/_all_docs${queryStr}`,
      method: 'GET',
      statusCodes: {
        200: 'OK - Request completed successfully'
      }
    })
  }

  /**
   * Get Document Head
   * @param  {String} dbName
   * @param  {String} docId
   * @param  {Object} [query]
   * @return {Promise}
   */
  couch.getDocumentHead = function getDocumentHead (dbName, docId, queryObj) {
    const queryStr = createQueryString(queryObj)
    return request({
      path: `${encodeURIComponent(dbName)}/${encodeURIComponent(docId)}${queryStr}`,
      method: 'HEAD',
      statusCodes: {
        200: 'OK - Document exists',
        304: 'Not Modified - Document wasn’t modified since specified revision',
        401: 'Unauthorized - Read privilege required',
        404: 'Not Found - Document not found'
      }
    })
  }

  /**
   * Get Document
   * @param  {String} dbName
   * @param  {String} docId
   * @param  {Object} [query]
   * @return {Promise}
   */
  couch.getDocument = function getDocument (dbName, docId, queryObj) {
    const queryStr = createQueryString(queryObj)
    return request({
      path: `${encodeURIComponent(dbName)}/${encodeURIComponent(docId)}${queryStr}`,
      method: 'GET',
      statusCodes: {
        200: 'OK - Request completed successfully',
        304: 'Not Modified - Document wasn’t modified since specified revision',
        400: 'Bad Request - The format of the request or revision was invalid',
        401: 'Unauthorized - Read privilege required',
        404: 'Not Found - Document not found'
      }
    })
  }

  /**
   * Copy an existing document to a new document
   * @param  {String} dbName
   * @param  {String} docId
   * @param  {String} newDocId
   * @return {Promise}
   */
  couch.copyDocument = function copyDocument (dbName, docId, newDocId) {
    if (docId && newDocId) {
      return request({
        headers: { Destination: newDocId },
        path: `${encodeURIComponent(dbName)}/${encodeURIComponent(docId)}`,
        method: 'COPY',
        statusCodes: {
          201: 'Created – Document created and stored on disk',
          202: 'Accepted – Document data accepted, but not yet stored on disk',
          400: 'Bad Request – Invalid request body or parameters',
          401: 'Unauthorized – Write privileges required',
          404: 'Not Found – Specified database or document ID doesn’t exists',
          409: 'Conflict – Document with the specified ID already exists or specified revision is not latest for target document'
        }
      })
    }
  }

  /**
   * Create a new document or new revision of an existing document
   * @param  {String} dbName
   * @param  {Object} doc
   * @param  {String} [docId]
   * @return {Promise}
   */
  couch.createDocument = function createDocument (dbName, doc, docId) {
    if (docId) {
      // create document by id (PUT)
      return request({
        path: `${encodeURIComponent(dbName)}/${encodeURIComponent(docId)}`,
        method: 'PUT',
        postData: doc,
        postContentType: 'application/json',
        statusCodes: {
          201: 'Created – Document created and stored on disk',
          202: 'Accepted – Document data accepted, but not yet stored on disk',
          400: 'Bad Request – Invalid request body or parameters',
          401: 'Unauthorized – Write privileges required',
          404: 'Not Found – Specified database or document ID doesn’t exists',
          409: 'Conflict – Document with the specified ID already exists or specified revision is not latest for target document'
        }
      })
    } else {
      // create document without explicit id (POST)
      return request({
        path: encodeURIComponent(dbName),
        method: 'POST',
        postData: doc,
        statusCodes: {
          201: 'Created – Document created and stored on disk',
          202: 'Accepted – Document data accepted, but not yet stored on disk',
          400: 'Bad Request – Invalid database name',
          401: 'Unauthorized – Write privileges required',
          404: 'Not Found – Database doesn’t exists',
          409: 'Conflict – A Conflicting Document with same ID already exists'
        }
      })
    }
  }

  /**
   * Delete a named document
   * @param  {String} dbName
   * @param  {String} docId
   * @param  {String} rev
   * @return {Promise}
   */
  couch.deleteDocument = function deleteDocument (dbName, docId, rev) {
    return request({
      path: `${encodeURIComponent(dbName)}/${encodeURIComponent(docId)}?rev=${rev}`,
      method: 'DELETE',
      statusCodes: {
        200: 'OK - Document successfully removed',
        202: 'Accepted - Request was accepted, but changes are not yet stored on disk',
        400: 'Bad Request - Invalid request body or parameters',
        401: 'Unauthorized - Write privilege required',
        404: 'Not Found - Specified database or document ID doesn\'t exist',
        409: 'Conflict - Specified revision is not the latest for target document'
      }
    })
  }

  /**
   * Find documents (requires CouchDB >= 2.0.0)
   * @param  {String} dbName
   * @param  {Object} queryObj
   * @return {Promise}
   */
  couch.findDocuments = function findDocuments (dbName, queryObj) {
    return request({
      path: `${encodeURIComponent(dbName)}/_find`,
      method: 'POST',
      postData: queryObj,
      statusCodes: {
        200: 'OK - Request completed successfully',
        400: 'Bad Request - Invalid request',
        401: 'Unauthorized - Read permission required',
        500: 'Internal Server Error - Query execution error'
      }
    })
  }

  /**
   * Get one or more UUIDs
   * @param  {Number} [count = 1]
   * @return {Promise}
   */
  couch.getUuids = function getUuids (count) {
    return request({
      path: `_uuids?count=${count || 1}`,
      method: 'GET',
      statusCodes: {
        200: 'OK - Request completed successfully',
        403: 'Forbidden – Requested more UUIDs than is allowed to retrieve'
      }
    })
  }

  /**
   * Get design document
   * @param  {String} dbName
   * @param  {String} docId
   * @param  {Object} [query]
   * @return {Promise}
   */
  couch.getDesignDocument = function getDesignDocument (dbName, docId, queryObj) {
    const queryStr = createQueryString(queryObj)
    return request({
      path: `${encodeURIComponent(dbName)}/_design/${encodeURIComponent(docId)}${queryStr}`,
      method: 'GET',
      statusCodes: {
        200: 'OK - Request completed successfully',
        304: 'Not Modified - Document wasn’t modified since specified revision',
        400: 'Bad Request - The format of the request or revision was invalid',
        401: 'Unauthorized - Read privilege required',
        404: 'Not Found - Document not found'
      }
    })
  }

  /**
   * Get design document info
   * @param  {String} dbName
   * @param  {String} docId
   * @return {Promise}
   */
  couch.getDesignDocumentInfo = function getDesignDocumentInfo (dbName, docId) {
    return request({
      path: `${encodeURIComponent(dbName)}/_design/${encodeURIComponent(docId)}/_info`,
      method: 'GET',
      statusCodes: {
        200: 'OK - Request completed successfully'
      }
    })
  }

  /**
   * Create a new design document or new revision of an existing design document
   * @param  {String} dbName
   * @param  {Object} doc
   * @param  {String} docId
   * @return {Promise}
   */
  couch.createDesignDocument = function createDesignDocument (dbName, doc, docId) {
    return request({
      path: `${encodeURIComponent(dbName)}/_design/${encodeURIComponent(docId)}`,
      method: 'PUT',
      postData: doc,
      statusCodes: {
        201: 'Created – Document created and stored on disk',
        202: 'Accepted – Document data accepted, but not yet stored on disk',
        400: 'Bad Request – Invalid request body or parameters',
        401: 'Unauthorized – Write privileges required',
        404: 'Not Found – Specified database or document ID doesn’t exists',
        409: 'Conflict – Document with the specified ID already exists or specified revision is not latest for target document'
      }
    })
  }

  /**
   * Delete a named design document
   * @param  {String} dbName
   * @param  {String} docId
   * @param  {String} rev
   * @return {Promise}
   */
  couch.deleteDesignDocument = function deleteDesignDocument (dbName, docId, rev) {
    return request({
      path: `${encodeURIComponent(dbName)}/_design/${encodeURIComponent(docId)}?rev=${rev}`,
      method: 'DELETE',
      statusCodes: {
        200: 'OK - Document successfully removed',
        202: 'Accepted - Request was accepted, but changes are not yet stored on disk',
        400: 'Bad Request - Invalid request body or parameters',
        401: 'Unauthorized - Write privilege required',
        404: 'Not Found - Specified database or document ID doesn\'t exist',
        409: 'Conflict - Specified revision is not the latest for target document'
      }
    })
  }

  /**
   * Get view
   * @param  {String} dbName
   * @param  {String} docId
   * @param  {String} viewName
   * @param  {Object} [query]
   * @return {Promise}
   */
  couch.getView = function getView (dbName, docId, viewName, queryObj) {
    const queryStr = createQueryString(queryObj)
    return request({
      path: `${encodeURIComponent(dbName)}/_design/${encodeURIComponent(docId)}/_view/${encodeURIComponent(viewName)}${queryStr}`,
      method: 'GET',
      statusCodes: {
        200: 'OK - Request completed successfully'
      }
    })
  }

  /**
   * Bulk docs
   * @param  {String} dbName
   * @param  {Array} docs
   * @param  {Object} [opts]
   * @return {Promise}
   */
  couch.createBulkDocuments = function createBulkDocuments (dbName, docs, opts) {
    const obj = {
      docs: docs
    }
    Object.assign(obj, opts)
    return request({
      path: `${encodeURIComponent(dbName)}/_bulk_docs`,
      method: 'POST',
      postData: obj,
      statusCodes: {
        201: 'Created – Document(s) have been created or updated',
        400: 'Bad Request – The request provided invalid JSON data',
        417: 'Expectation Failed – Occurs when all_or_nothing option set as true and at least one document was rejected by validation function',
        500: 'Internal Server Error – Malformed data provided, while it’s still valid JSON'
      }
    })
  }

  // http://docs.couchdb.org/en/latest/api/document/common.html#attachments

  /**
   * Get attachment head
   * @param  {String} dbName
   * @param  {String} docId
   * @param  {String} attName
   * @param  {String} [rev]
   * @return {Promise}
   */
  couch.getAttachmentHead = function getAttachmentHead (dbName, docId, attName, rev) {
    const queryStr = rev ? `?rev=${rev}` : ''
    return request({
      path: `${encodeURIComponent(dbName)}/${encodeURIComponent(docId)}/${encodeURIComponent(attName)}${queryStr}`,
      method: 'HEAD',
      statusCodes: {
        200: 'OK - Attachment exists',
        304: 'Not Modified - Attachment wasn’t modified if ETag equals specified If-None-Match header',
        401: 'Unauthorized - Read privilege required',
        404: 'Not Found - Specified database, document or attchment was not found'
      }
    })
  }

  /**
   * get attachment
   * @param  {String} dbName
   * @param  {String} docId
   * @param  {String} attName
   * @param  {StreamWritable} stream
   * @param  {String} [rev]
   * @return {Promise}
   */
  couch.getAttachment = function getAttachment (dbName, docId, attName, stream, rev) {
    const queryStr = rev ? `?rev=${rev}` : ''
    return Promise.resolve()
      .then(() => requestStream({
        path: `${encodeURIComponent(dbName)}/${encodeURIComponent(docId)}/${encodeURIComponent(attName)}${queryStr}`,
        stream: stream,
        statusCodes: {
          200: 'OK - Attachment exists',
          304: 'Not Modified - Attachment wasn’t modified if ETag equals specified If-None-Match header',
          401: 'Unauthorized - Read privilege required',
          404: 'Not Found - Specified database, document or attchment was not found'
        }
      })
      .then(response => new Promise(function (resolve, reject) {
        stream.on('close', function () {
          return resolve(response)
        })
        stream.on('error', function (err) {
          return reject({
            headers: {},
            data: {error: err},
            status: 500,
            message: err.message || 'stream error'
          })
        })
      }))
    )
  }

  /**
   * add attachment
   * @param  {String} dbName
   * @param  {String} docId
   * @param  {String} attName
   * @param  {String} rev
   * @param  {String} contentType
   * @param  {Buffer|String} att
   * @return {Promise}
   */
  couch.addAttachment = function addAttachment (dbName, docId, attName, rev, contentType, data) {
    const queryStr = rev ? `?rev=${rev}` : ''
    return request({
      path: `${encodeURIComponent(dbName)}/${encodeURIComponent(docId)}/${encodeURIComponent(attName)}${queryStr}`,
      method: 'PUT',
      postContentType: contentType,
      postData: data,
      statusCodes: {
        201: 'OK - Created',  // TODO: check with API again
        202: 'Accepted - Request was but changes are not yet stored on disk',
        401: 'Unauthorized - Write privilege required',
        404: 'Not Found - Specified database, document or attchment was not found',
        409: '409 Conflict – Document’s revision wasn’t specified or it’s not the latest'
      }
    })
  }

  /**
   * delete attachment
   * @param  {String} dbName
   * @param  {String} docId
   * @param  {String} attName
   * @param  {String} rev
   * @return {Promise}
   */
  couch.deleteAttachment = function deleteAttachment (dbName, docId, attName, rev) {
    const queryStr = rev ? `?rev=${rev}` : ''
    return request({
      path: `${encodeURIComponent(dbName)}/${encodeURIComponent(docId)}/${encodeURIComponent(attName)}${queryStr}`,
      method: 'DELETE',
      statusCodes: {
        200: 'OK – Attachment successfully removed',
        202: 'Accepted - Request was but changes are not yet stored on disk',
        400: '400 Bad Request – Invalid request body or parameters',
        401: 'Unauthorized - Write privilege required',
        404: 'Not Found - Specified database, document or attchment was not found',
        409: '409 Conflict – Document’s revision wasn’t specified or it’s not the latest'
      }
    })
  }

  /**
   * create index (requires CouchDB >= 2.0.0)
   * @param  {String} dbName
   * @param  {Object} queryObj
   * @return {Promise}
   */
  couch.createIndex = function createIndex (dbName, queryObj) {
    return request({
      path: `${encodeURIComponent(dbName)}/_index`,
      method: 'POST',
      postData: queryObj,
      statusCodes: {
        200: 'OK - Index created successfully or already exists',
        400: 'Bad Request - Invalid request',
        401: 'Unauthorized - Admin permission required',
        500: 'Internal Server Error - Execution error'
      }
    })
  }

  /**
   * get index (requires CouchDB >= 2.0.0)
   * @param  {String} dbName
   * @return {Promise}
   */
  couch.getIndex = function getIndex (dbName) {
    return request({
      path: `${encodeURIComponent(dbName)}/_index`,
      method: 'GET',
      statusCodes: {
        200: 'OK - Success',
        400: 'Bad Request - Invalid request',
        401: 'Unauthorized - Read permission required',
        500: 'Internal Server Error - Execution error'
      }
    })
  }

  /**
   * delete index (requires CouchDB >= 2.0.0)
   * @param  {String} dbName
   * @param  {String} docId - design document id
   * @param  {String} name - index name
   * @return {Promise}
   */
  couch.deleteIndex = function deleteIndex (dbName, docId, name) {
    return request({
      path: `${encodeURIComponent(dbName)}/_index/${encodeURIComponent(docId)}/json/${encodeURIComponent(name)}`,
      method: 'DELETE',
      statusCodes: {
        200: 'OK - Success',
        400: 'Bad Request - Invalid request',
        401: 'Unauthorized - Writer permission required',
        404: 'Not Found - Index not found',
        500: 'Internal Server Error - Execution error'
      }
    })
  }

  /**
   * generic request function
   * @param  {String} path    e.g. '_all_dbs'
   * @return {Promise}
   */
  couch.getUrlPath = function (path) {
    return request({
      path: path,
      methode: 'GET'
    })
  }

  return couch
}

