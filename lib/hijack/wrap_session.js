var Fibers = Npm.require('fibers');
//only method, sub and unsub are valid messages
//so following fields would only required
var WAITON_MESSAGE_FIELDS = ['msg', 'id', 'method', 'name'];

wrapSession = function(sessionProto) {

  var currentlyProcessingDDPMessage;

  var originalProcessMessage = sessionProto.processMessage;
  sessionProto.processMessage = function(msg) {
    var apmInfo = {
      session: this.id,
      userId: this.userId
    };

    if(msg.msg == 'method') {
      apmInfo.method = {
        name: msg.method,
        id: msg.id
      };
      msg.__apmInfo = apmInfo;

      var waitOnMessages = this.inQueue.map(function(msg) {
        return _.pick(msg, WAITON_MESSAGE_FIELDS);
      });

      //add currently processing ddp message if exists
      if(this.workerRunning) {
        waitOnMessages.unshift(_.pick(currentlyProcessingDDPMessage, WAITON_MESSAGE_FIELDS));
      }

      NotificationManager.methodTrackEvent('start', null, apmInfo);
      NotificationManager.methodTrackEvent('wait', {waitOn: waitOnMessages}, apmInfo);
    }

    return originalProcessMessage.call(this, msg);
  };

  //adding the method context to the current fiber
  var originalMethodHandler = sessionProto.protocol_handlers.method;
  sessionProto.protocol_handlers.method = function(msg, unblock) {
    currentlyProcessingDDPMessage = msg;
    //add context
    Fibers.current.__apmInfo = msg.__apmInfo;

    NotificationManager.methodTrackEvent('waitend');

    return originalMethodHandler.call(this, msg, unblock);
  };

  //to capture the currently processing message
  var orginalSubHandler = sessionProto.protocol_handlers.sub;
  sessionProto.protocol_handlers.sub = function(msg, unblock) {
    currentlyProcessingDDPMessage = msg;
    return orginalSubHandler.call(this, msg, unblock);
  };

  //to capture the currently processing message
  var orginalUnSubHandler = sessionProto.protocol_handlers.unsub;
  sessionProto.protocol_handlers.unsub = function(msg, unblock) {
    currentlyProcessingDDPMessage = msg;
    return orginalUnSubHandler.call(this, msg, unblock);
  };

  //track method ending (to get the result of error)
  var originalSend = sessionProto.send;
  sessionProto.send = function(msg) {
    if(msg.msg == 'result') {
      if(msg.error) {
        var error = msg.error;

        //pick the error from the __apmInfo if setted with 
        //DDPServer._CurrentWriteFence.withValue hijack
        var apmInfo = Fibers.current.__apmInfo;
        if(apmInfo && apmInfo.currentError) {
          error = apmInfo.currentError;
        }
        error = _.pick(error, ['message', 'stack']);

        NotificationManager.methodEndLastEvent();
        NotificationManager.methodTrackEvent('error', {error: error});
      } else {
        NotificationManager.methodTrackEvent('complete');
      }
    }

    return originalSend.call(this, msg);
  };
};

//We need this hijack to get the correct exception from the method
//otherwise, what we get from the session.send is something customized for the client

var originalWithValue = DDPServer._CurrentWriteFence.withValue;
DDPServer._CurrentWriteFence.withValue = function(value, func) {
  try {
    return originalWithValue.call(DDPServer._CurrentWriteFence, value, func);
  } catch(ex) {
    if(Fibers.current.__apmInfo) {
      Fibers.current.__apmInfo.currentError = ex;
    }
    throw ex;
  }
};