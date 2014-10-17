var IronMQ        = require("iron_mq");
var Stream        = require("stream");
var _             = require("lodash");
var util          = require("util");
var EventEmitter  = require("events").EventEmitter;
var JsonParser    = require("./jsonparser");
var debug         = require("debug")("ironmq-queue");
var inspect       = require("util").inspect;
var EventEmitter  = require("events").EventEmitter;
var inherits      = require("util").inherits;
var async         = require("async");

util.inherits(Queue, Stream.Readable);
util.inherits(Sink, Stream.Writable);

function IronStream(config) {
  if(!config.projectId || !config.projectToken) {
    throw new Error("Must include both `projectId` and `projectToken`");
  }
  if(!(this instanceof IronStream)) {
    return new IronStream(config);
  }
  this.MQ = new IronMQ.Client(
                _.merge({project_id: config.projectId, token: config.projectToken},
                _.omit(config, "projectId", "projectToken")));
  this.queues = {};
}

/*
 * @param name {String}: Name of the queue to connect to
 * @param options {Object}:
          options.checkEvery {Num} - Interval with which to check ironMQ in ms.
          options.maxMessagesPerEvent {Num} - The maximum number of messages to return in any given push.
*/


IronStream.prototype.queue = function(name, options) {
  if(options.maxMessagesPerEvent) {
    options.n = options.maxMessagesPerEvent;
    delete options.maxMessagesPerEvent;
  }
  var options = _.merge({
      checkEvery: 1000,
      n: 10
    }, (options || {}));
  this.queues[name] = this.queues[name]
    || new Queue(this, name, options);
  return this.queues[name];
};


function Queue(ironStream, name, options) {
  var me = this;
  Stream.Readable.call(this, {objectMode: true});
  this.name = name;
  this.options = options;
  this.q = ironStream.MQ.queue(name);
  this.running = true;
  this.messages = [];
  this.fetcher = new Fetcher(me.q.get.bind(me.q, options), options.checkEvery);

  /* add default fetcher handlers */
  this.fetcher.on("results", function(results) {
    if(!_.isEmpty(results)) {
      me._addMessagesToQueue(results);
    }
  });
  this.fetcher.on("error", function(err) {
    me.emit("queueError", err);
  });
  this.firstMessageListener = function(results) {
    if(!_.isEmpty(results)) {
      me._pushOneMessage();
      if(!_.isEmpty(me.messages)) me.fetcher.stop();
    }
  };
}


Queue.prototype._pushOneMessage = function() {
  debug("Pushing one message downstream");
  if(!this.push(this.messages.shift())) {
    debug("Downstream backpressure detected");
  }
}

Queue.prototype._read = function(s) {
  debug("System called _read");
  var me = this;
  if(_.isEmpty(this.messages)) {
    if(!this.fetcher.running) {
      this.fetcher.start();
    }
    this.fetcher.once("results", this.firstMessageListener);
  } else {
    if(this.fetcher.running) {
      this.fetcher.stop();
    }
    me._pushOneMessage();
  }
};

Queue.prototype._isFetching = function() {
  return !!this.__i;
}

Queue.prototype._addMessagesToQueue = function(messages) {
  messages = _.isArray(messages) ? messages : [messages];
  debug("Adding " + messages.length + " messages to queue");
  this.messages = this.messages.concat(messages);
};

/*
 * Function: resume
 *
 * Used to resume a queue after calling stop.
*/
Queue.prototype.resume = function() {
  debug("Resuming...");
  this.running = true;
};

Queue.prototype.onFetchError = function(f) {
  this.on("queueError", f);
};

/*
 * Function: stopFetching
 *
 * Client-safe way to stop the underlying polling of IronMQ.
 *
*/
Queue.prototype.stopFetching = function() {
  this.fetcher.shutdown();
};


Queue.prototype.resetMessages = function() {
  this.messages = [];
};

/*
 * Provides a writable stream for ironmq manipulation. Messages written to the
 * stream will be deleted from the remote queue.

 Sink should be used downstream of an IronmqStream instance.

 @param instance of IronStream.Queue.  This is returned when .queue()
        is invoked on an instantiated IronStream object.
*/
function Sink(ironmqQueue) {
  Stream.Writable.call(this, {objectMode: true, decodeStrings: false});
  this.q = ironmqQueue.q;
}


Sink.prototype._write = function(message, enc, next) {
  if(!message.id) {
    return this.emit("deleteError", new Error("Message does not have an `id` property"), message);
  }
  this.q.del(message.id, function(err) {
    if(err) {
      this.emit("deleteError", error);
    }
    debug("Deleted message: " + message.id);
    next();
  });
};

Sink.prototype.onDeleteError = function(f) {
  this.on("deleteError", f);
};



/* Fetcher*/

inherits(Fetcher, EventEmitter);

function Fetcher (fetch, interval) {
  this.interval = interval;
  this.fetch = fetch;
  this.running = false;
}

Fetcher.prototype.start = function() {
  var me = this;
  this.running = true;
  debug("Starting fetcher");
  if(!this.__i && !this.shuttingDown) {
    this.__i = setInterval(function() {
      me.fetch(function(err, results) {
        if(err) {
          debug("Error in fetch: " + err.message);
          return me.emit("error", err);
        }
        me.emit("results", results);
      });
    }, this.interval);
  }
}

Fetcher.prototype.stop = function() {
  debug("Stopping fetcher")
  this.running = false;
  if(this.__i) {
    clearInterval(this.__i);
    this.__i = null;
  }
};

Fetcher.prototype.shutdown = function() {
  this.shuttingDown = true;
  this.stop();
}



exports.IronStream = IronStream;
exports.Queue = Queue;
exports.Sink = Sink;

/*
  @param ironmqStream {Stream} A configured ironmq stream.
  @param onParseError {Function} Called when there's a parsing error.
*/

exports.parseJson = function(ironmqStream, onParseError) {
  var parsedStream = new JsonParser({parseField: "body", enrichWith: ["id"]});
  parsedStream.on("parseError", onParseError || function() {});
  return ironmqStream
            .pipe(parsedStream);
};


exports.useStub = function(stub) {
  IronMQ = stub;
};
