'use strict'
const db = require('../index')
const baseUrl = process.env.DB_URL || 'http://localhost:5984'

const dbName = 'testdb_' + Math.random().toString(36).slice(2, 8)

function insertDocuments () {
  let p = Promise.resolve()
  const MONTHS = ['January', 'February', 'March', 'April', 'Mai', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  MONTHS.forEach((month, idx) => {
    p = p.then(() => db.createDocument(baseUrl, dbName, {
      name: month,
      number: idx + 1
    }))
  })
  return p
}

// create database and insert some documents
db.createDatabase(baseUrl, dbName)
.then(insertDocuments)

// create new design document
.then(() => db.createDesignDocument(baseUrl, dbName, {
  language: 'javascript',
  views: {
    all: {
      map: 'function (doc) {emit(doc.name, doc.number)}'
    }
  }
}, 'ddoc1'))
.then(console.log)
// { data:
//    { ok: true,
//     id: '_design/ddoc1',
//     rev: '1-d37fe4f1c56b171b853f0d5818372afb' },
//  status: 201,
//  message: 'Created – Document created and stored on disk' }

// get design document
.then(() => db.getDesignDocument(baseUrl, dbName, 'ddoc1'))
.then(console.log)
// { data:
//   { _id: '_design/ddoc1',
//     _rev: '1-d37fe4f1c56b171b853f0d5818372afb',
//     language: 'javascript',
//     views: { all: [Object] } },
//  status: 200,
//  message: 'OK - Request completed successfully' }

// get design document info
.then(() => db.getDesignDocumentInfo(baseUrl, dbName, 'ddoc1'))
.then(console.log)
// { data:
//    { name: 'ddoc1',
//      view_index:
//       { signature: 'ab80d071339d5fda3e4d94a79c5a0b9d',
//         language: 'javascript',
//         disk_size: 51,
//         data_size: 0,
//         update_seq: 0,
//         purge_seq: 0,
//         updater_running: false,
//         compact_running: false,
//         waiting_commit: false,
//         waiting_clients: 0 } },
//  status: 200,
//  message: 'OK - Request completed successfully' }

// request some data from view
.then(() => db.getView(baseUrl, dbName, 'ddoc1', 'all', {
  decending: true,
  limit: 3
}))
.then(console.log)
// { data:
//    { total_rows: 12,
//      offset: 0,
//      rows: [ [Object], [Object], [Object] ] },
//   status: 200,
//   message: 'OK - Request completed successfully' }

// delete design document
// get current revision - then delete
.then(() => db.getDesignDocument(baseUrl, dbName, 'ddoc1'))
.then(response => db.deleteDesignDocument(baseUrl, dbName, 'ddoc1', response.data._rev))
.then(console.log)
// { data:
//    { ok: true,
//      id: '_design/ddoc1',
//      rev: '2-acf287694d12734622438c9e7426d2be' },
//   status: 200,
//   message: 'OK - Document successfully removed' }

// delete database
.then(() => db.deleteDatabase(baseUrl, dbName))
.catch(console.error)
