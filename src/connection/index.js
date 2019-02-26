'use strict'

const FSM = require('fsm-event')
const Circuit = require('libp2p-circuit')
const multistream = require('multistream-select')
const withIs = require('class-is')
const BaseConnection = require('./base')

const observeConnection = require('../observe-connection')
const Errors = require('../errors')

/**
 * @typedef {Object} ConnectionOptions
 * @property {Switch} _switch Our switch instance
 * @property {PeerInfo} peerInfo The PeerInfo of the peer to dial
 * @property {Muxer} muxer Optional - A muxed connection
 * @property {Connection} conn Optional - The base connection
 * @property {string} type Optional - identify the connection as incoming or outgoing. Defaults to out.
 */

/**
 * ConnectionFSM handles the complex logic of managing a connection
 * between peers. ConnectionFSM is internally composed of a state machine
 * to help improve the usability and debuggability of connections. The
 * state machine also helps to improve the ability to handle dial backoff,
 * coalescing dials and dial locks.
 */
class ConnectionFSM extends BaseConnection {
  /**
   * @param {ConnectionOptions} param0
   * @constructor
   */
  constructor ({ _switch, peerInfo, muxer, conn, type = 'out' }) {
    super({
      _switch,
      name: `${type}:${_switch._peerInfo.id.toB58String().slice(0, 8)}`
    })

    this.theirPeerInfo = peerInfo
    this.theirB58Id = this.theirPeerInfo.id.toB58String()

    this.conn = conn // The base connection
    this.muxer = muxer // The upgraded/muxed connection

    let startState = 'DISCONNECTED'
    if (this.muxer) {
      startState = 'MUXED'
    }

    this._state = FSM(startState, {
      DISCONNECTED: { // No active connections exist for the peer
        dial: 'DIALING',
        disconnect: 'DISCONNECTED',
        done: 'DISCONNECTED'
      },
      DIALING: { // Creating an initial connection
        abort: 'ABORTED',
        // emit events for different transport dials?
        done: 'DIALED',
        error: 'ERRORED',
        disconnect: 'DISCONNECTING'
      },
      DIALED: { // Base connection to peer established
        encrypt: 'ENCRYPTING',
        privatize: 'PRIVATIZING'
      },
      PRIVATIZING: { // Protecting the base connection
        done: 'PRIVATIZED',
        abort: 'ABORTED',
        disconnect: 'DISCONNECTING'
      },
      PRIVATIZED: { // Base connection is protected
        encrypt: 'ENCRYPTING'
      },
      ENCRYPTING: { // Encrypting the base connection
        done: 'ENCRYPTED',
        error: 'ERRORED',
        disconnect: 'DISCONNECTING'
      },
      ENCRYPTED: { // Upgrading could not happen, the connection is encrypted and waiting
        upgrade: 'UPGRADING',
        disconnect: 'DISCONNECTING'
      },
      UPGRADING: { // Attempting to upgrade the connection with muxers
        stop: 'CONNECTED', // If we cannot mux, stop upgrading
        done: 'MUXED',
        error: 'ERRORED'
      },
      MUXED: {
        disconnect: 'DISCONNECTING'
      },
      CONNECTED: { // A non muxed connection is established
        disconnect: 'DISCONNECTING'
      },
      DISCONNECTING: { // Shutting down the connection
        done: 'DISCONNECTED',
        disconnect: 'DISCONNECTING'
      },
      ABORTED: { }, // A severe event occurred
      ERRORED: { // An error occurred, but future dials may be allowed
        disconnect: 'DISCONNECTING' // There could be multiple options here, but this is a likely action
      }
    })

    this._state.on('DISCONNECTED', () => this._onDisconnected())
    this._state.on('DIALING', () => this._onDialing())
    this._state.on('DIALED', () => this._onDialed())
    this._state.on('PRIVATIZING', () => this._onPrivatizing())
    this._state.on('PRIVATIZED', () => this._onPrivatized())
    this._state.on('ENCRYPTING', () => this._onEncrypting())
    this._state.on('ENCRYPTED', () => {
      this.log(`successfully encrypted connection to ${this.theirB58Id}`)
      this.emit('encrypted', this.conn)
    })
    this._state.on('UPGRADING', () => this._onUpgrading())
    this._state.on('MUXED', () => {
      this.log(`successfully muxed connection to ${this.theirB58Id}`)
      delete this.switch.conns[this.theirB58Id]
      this.emit('muxed', this.muxer)
    })
    this._state.on('CONNECTED', () => {
      this.log(`unmuxed connection opened to ${this.theirB58Id}`)
      this.emit('unmuxed', this.conn)
    })
    this._state.on('DISCONNECTING', () => this._onDisconnecting())
    this._state.on('ABORTED', () => this._onAborted())
    this._state.on('ERRORED', () => this._onErrored())
    this._state.on('error', (err) => this._onStateError(err))
  }

  /**
   * Puts the state into dialing mode
   *
   * @fires ConnectionFSM#Error May emit a DIAL_SELF error
   * @returns {void}
   */
  dial () {
    if (this.theirB58Id === this.ourPeerInfo.id.toB58String()) {
      return this.emit('error', Errors.DIAL_SELF())
    } else if (this.getState() === 'DIALING') {
      return this.log('attempted to dial while already dialing, ignoring')
    }

    this._state('dial')
  }

  /**
   * Initiates a handshake for the given protocol
   *
   * @param {string} protocol The protocol to negotiate
   * @param {function(Error, Connection)} callback
   * @returns {void}
   */
  shake (protocol, callback) {
    // If there is no protocol set yet, don't perform the handshake
    if (!protocol) {
      return callback(null, null)
    }

    if (this.muxer && this.muxer.newStream) {
      return this.muxer.newStream((err, stream) => {
        if (err) {
          return callback(err, null)
        }

        this.log(`created new stream to ${this.theirB58Id}`)
        this._protocolHandshake(protocol, stream, callback)
      })
    }

    this._protocolHandshake(protocol, this.conn, callback)
  }

  /**
   * Puts the state into muxing mode
   *
   * @returns {void}
   */
  upgrade () {
    this._state('upgrade')
  }

  /**
   * Event handler for dialing. Transitions state when successful.
   *
   * @private
   * @fires ConnectionFSM#error
   * @returns {void}
   */
  _onDialing () {
    this.log(`dialing ${this.theirB58Id}`)

    if (!this.switch.hasTransports()) {
      return this.close(Errors.NO_TRANSPORTS_REGISTERED())
    }

    const tKeys = this.switch.availableTransports(this.theirPeerInfo)

    const circuitEnabled = Boolean(this.switch.transports[Circuit.tag])
    let circuitTried = false

    const nextTransport = (key) => {
      let transport = key
      if (!transport) {
        if (!circuitEnabled) {
          return this.close(Errors.CONNECTION_FAILED(
            new Error(`Circuit not enabled and all transports failed to dial peer ${this.theirB58Id}!`)
          ))
        }

        if (circuitTried) {
          return this.close(Errors.CONNECTION_FAILED(
            new Error(`No available transports to dial peer ${this.theirB58Id}!`)
          ))
        }

        this.log(`Falling back to dialing over circuit`)
        this.theirPeerInfo.multiaddrs.add(`/p2p-circuit/ipfs/${this.theirB58Id}`)
        circuitTried = true
        transport = Circuit.tag
      }

      this.log(`dialing transport ${transport}`)
      this.switch.transport.dial(transport, this.theirPeerInfo, (err, _conn) => {
        if (err) {
          this.emit('error:connection_attempt_failed', err.errors || [err])
          this.log(err)
          return nextTransport(tKeys.shift())
        }

        this.conn = observeConnection(transport, null, _conn, this.switch.observer)
        this._state('done')
      })
    }

    nextTransport(tKeys.shift())
  }

  /**
   * Once a connection has been successfully dialed, the connection
   * will be privatized or encrypted depending on the presence of the
   * Switch.protector.
   *
   * @returns {void}
   */
  _onDialed () {
    this.log(`successfully dialed ${this.theirB58Id}`)

    this.emit('connected', this.conn)
  }

  /**
   * Event handler for disconnecting. Handles any needed cleanup
   *
   * @returns {void}
   */
  _onDisconnecting () {
    this.log(`disconnecting from ${this.theirB58Id}`)

    // Issue disconnects on both Peers
    if (this.theirPeerInfo) {
      this.theirPeerInfo.disconnect()
    }

    // Clean up stored connections
    if (this.muxer) {
      this.muxer.end()
    }

    this.switch.connection.remove(this)

    delete this.switch.conns[this.theirB58Id]
    delete this.muxer

    // If we have the base connection, abort it
    if (this.conn) {
      this.conn.source(true, () => {
        this._state('done')
        this.switch.emit('peer-mux-closed', this.theirPeerInfo)
        delete this.conn
      })
    } else {
      this._state('done')
      this.switch.emit('peer-mux-closed', this.theirPeerInfo)
    }
  }

  /**
   * Attempts to encrypt `this.conn` with the Switch's crypto.
   *
   * @private
   * @fires ConnectionFSM#error
   * @returns {void}
   */
  _onEncrypting () {
    const msDialer = new multistream.Dialer()
    msDialer.handle(this.conn, (err) => {
      if (err) {
        return this.close(Errors.maybeUnexpectedEnd(err))
      }

      this.log('selecting crypto %s to %s', this.switch.crypto.tag, this.theirB58Id)

      msDialer.select(this.switch.crypto.tag, (err, _conn) => {
        if (err) {
          return this.close(Errors.maybeUnexpectedEnd(err))
        }

        const conn = observeConnection(null, this.switch.crypto.tag, _conn, this.switch.observer)

        this.conn = this.switch.crypto.encrypt(this.ourPeerInfo.id, conn, this.theirPeerInfo.id, (err) => {
          if (err) {
            return this.close(err)
          }

          this.conn.setPeerInfo(this.theirPeerInfo)
          this._state('done')
        })
      })
    })
  }

  /**
   * Iterates over each Muxer on the Switch and attempts to upgrade
   * the given `connection`. Successful muxed connections will be stored
   * on the Switch.muxedConns with `b58Id` as their key for future reference.
   *
   * @private
   * @returns {void}
   */
  _onUpgrading () {
    const muxers = Object.keys(this.switch.muxers)
    this.log(`upgrading connection to ${this.theirB58Id}`)

    if (muxers.length === 0) {
      return this._state('stop')
    }

    const msDialer = new multistream.Dialer()
    msDialer.handle(this.conn, (err) => {
      if (err) {
        return this._didUpgrade(err)
      }

      msDialer.ls((err, protocols) => {
         if(err) {
	   return this._didUpgrade(err)
	 }
	 protocols.forEach((protocol) => {
	    this.theirPeerInfo.protocols.add(protocol)
	 })
      })

      this.theirPeerInfo.protocols.forEach((protocol) => {
      
      })

      // 1. try to handshake in one of the muxers available
      // 2. if succeeds
      //  - add the muxedConn to the list of muxedConns
      //  - add incomming new streams to connHandler
      /*const nextMuxer = (key) => {
        this.log('selecting %s', key)
        msDialer.select(key, (err, _conn) => {
          if (err) {
            if (muxers.length === 0) {
              return this._didUpgrade(err)
            }

            return nextMuxer(muxers.shift())
          }

          // observe muxed connections
          const conn = observeConnection(null, key, _conn, this.switch.observer)

          this.muxer = this.switch.muxers[key].dialer(conn)
          // this.switch.muxedConns[this.theirB58Id] = this
          this.switch.connection.add(this)

          this.muxer.once('close', () => {
            this.close()
          })

          // For incoming streams, in case identify is on
          this.muxer.on('stream', (conn) => {
            this.log(`new stream created via muxer to ${this.theirB58Id}`)
            conn.setPeerInfo(this.theirPeerInfo)
            this.switch.protocolMuxer(null)(conn)
          })

          this.switch.emit('peer-mux-established', this.theirPeerInfo)

          this._didUpgrade(null)
        })
      }

      nextMuxer(muxers.shift())*/
    })
  }

  /**
   * Analyses the given error, if it exists, to determine where the state machine
   * needs to go.
   *
   * @param {Error} err
   * @returns {void}
   */
  _didUpgrade (err) {
    if (err) {
      this.log('Error upgrading connection:', err)
      this.switch.conns[this.theirB58Id] = this
      this.emit('error:upgrade_failed', err)
      // Cant upgrade, hold the encrypted connection
      return this._state('stop')
    }

    // move the state machine forward
    this._state('done')
  }

  /**
   * Performs the protocol handshake for the given protocol
   * over the given connection. The resulting error or connection
   * will be returned via the callback.
   *
   * @private
   * @param {string} protocol
   * @param {Connection} connection
   * @param {function(Error, Connection)} callback
   * @returns {void}
   */
  _protocolHandshake (protocol, connection, callback) {
    const msDialer = new multistream.Dialer()
    msDialer.handle(connection, (err) => {
      if (err) {
        return callback(err, null)
      }

      msDialer.select(protocol, (err, _conn) => {
        if (err) {
          this.log(`could not perform protocol handshake: `, err)
          return callback(err, null)
        }

        const conn = observeConnection(null, protocol, _conn, this.switch.observer)
        this.log(`successfully performed handshake of ${protocol} to ${this.theirB58Id}`)
        this.emit('connection', conn)
        callback(null, conn)
      })
    })
  }

  /**
   * Event handler for state transition errors
   *
   * @param {Error} err
   * @returns {void}
   */
  _onStateError (err) {
    this.emit('error', Errors.INVALID_STATE_TRANSITION(err))
    this.log(err)
  }
}

module.exports = withIs(ConnectionFSM, {
  className: 'ConnectionFSM',
  symbolName: 'libp2p-switch/ConnectionFSM'
})
