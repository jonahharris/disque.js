var test = require('tape');
var disque = require('./index');
var mock = require('./mock');

const NODES = ['127.0.0.1:7711', '127.0.0.1:7712', '127.0.0.1:7713'];
const CYCLE = 5;
const OPTIONS = {cycle: CYCLE};

function prepare(cb) {
  return function(t) {
    var client = disque.connect(NODES, OPTIONS);

    Promise.all(NODES.map(function(node) {
      return new Promise(function(resolve, reject) {
        var c = disque.connect([node]);

        c.call('DEBUG', 'FLUSHALL', function(err, res) {
          if (err) return reject(err);
          resolve(c);
        });
      });
    })).then(function(clients) {
      clients.forEach(function(c) {
        c.quit();
      });

      var end = t.end

      t.end = function(err) {
        client.quit();
        end.call(t, err);
      };

      try {
        cb(t, client);
      }
      catch (ex) {
        t.end(new Error(ex));
      }
    }).catch(function(err) {
      t.end(err);
    });
  }
}

test('ping', prepare(function(t, client) {
  client.call('PING', function(err, res) {
    t.assert(err == null);
    t.equal(res, 'PONG');
    t.end(err);
  });
}));

test('info', prepare(function(t, client) {
  client.info(function(err, res) {
    t.assert(err === null);
    t.equal(res.loading, '0');
    t.end(err);
  });
}));

test('errors in callbacks', prepare(function(t, client) {
  client.call('FOOBAR', function(err, res) {
    t.assert(err);
    t.assert(err.message.match(/^ERR unknown command/));
    t.equal(res, undefined);
    t.end();
  });
}));

test('addjob', prepare(function(t, client) {
  client.addjob('q1', 'j1', 0, function(err, res) {
    t.assert(err === null);
    t.assert(res.length > 0);

    client.info(function(err, info) {
      t.equal(info.registered_jobs, '1');
      t.end(err);
    });
  });
}));

test('addjob with options', prepare(function(t, client) {
  client.addjob('q1', 'j1', 0, function() {
    client.addjob('q1', 'j2', 0, function() {
      client.addjob('q1', 'j3', 0, {maxlen: 1}, function(err, res) {
        t.assert(err);
        t.assert(res == null);
        t.end();
      });
    });
  });
}));

test('getjob', prepare(function(t, client) {
  client.addjob('q3', 'j3', 0, function(err, res) {
    t.assert(err === null);

    client.getjob(['q3'], function(err, jobs) {
      t.assert(err === null);
      t.equal(jobs.length, 1);

      var job = jobs[0];

      t.equal(job[0], 'q3');
      t.assert(job[1].length > 0);
      t.equal(job[2], 'j3');
      t.end(err);
    });
  });
}));

test('getjob with options', prepare(function(t, client) {
  client.addjob('q4', 'j4', 0, function() {
    client.addjob('q4', 'j5', 0, function() {
      client.getjob(['q4'], {count: 1}, function(err, jobs) {
        t.assert(err === null);
        t.equal(jobs.length, 1);

        var job = jobs[0];

        t.equal(job[0], 'q4');
        t.assert(job[1].length > 0);
        t.equal(job[2], 'j4');
        t.end(err);
      });
    });
  });
}));

test('connect to the best node for job consumption', prepare(function(t, client) {
  var c1 = disque.connect([NODES[1]], OPTIONS);

  client.call('PING', function() {
    var count = 0
      , prefix = client.prefix;

    t.assert(prefix.length === 8);
    t.notEqual(prefix, c1.prefix);

    var check = function(err) {
      client.call('PING', function(err) {
        t.equal(client.prefix, c1.prefix);
        t.end(err);
      });
    }

    for (var i = 0; i < CYCLE; i++) {
      c1.addjob('q5', 'j1', 0, function(err, res) {
        client.getjob(['q5'], {count: 1}, function(err, jobs) {
          count++;

          if (count === CYCLE) {
            c1.quit();
            check();
          }
        });
      });
    }
  });
}));

test('restrict node discovery to the provided nodes', prepare(function(t, client) {
  // Produce in node #3, assert that consumer never connects to it.
  var producer = disque.connect([NODES[2]], OPTIONS);
  var consumer = disque.connect([NODES[0], NODES[1]], OPTIONS);

  consumer.call('PING', function() {
    producer.call('PING', function() {
      var count = 0
        , prefix = consumer.prefix;

      t.assert(prefix.length === 8);
      t.notEqual(prefix, producer.prefix);

      var check = function(err) {
        consumer.call('PING', function(err) {
          if (err) return t.end(err);

          t.notEqual(consumer.prefix, producer.prefix);
          consumer.quit();
          producer.quit();
          t.end();
        });
      }

      for (var i = 0; i < CYCLE; i++) {
        producer.addjob('q5', 'j1', 0, function(err, res) {
          consumer.getjob(['q5'], {count: 1}, function(err, jobs) {
            count++;

            if (count === CYCLE) {
              check();
            }
          });
        });
      }
    });
  });
}));

test('ackjob', prepare(function(t, client) {
  client.addjob('q6', 'j1', 0, function(err, id) {
    client.ackjob(id, function(err, count) {
      t.equal(count, 1);

      client.call('SHOW', id, function(err, info) {
        t.assert(info === null);
        t.end(err);
      });
    });
  });
}));

test('ackjob with multiple IDs', prepare(function(t, client) {
  client.addjob('q7', 'j1', 0, function(err, id1) {
    client.addjob('q7', 'j2', 0, function(err, id2) {
      client.ackjob([id1, id2], function(err, count) {
        t.equal(count, 2);

        client.call('SHOW', id1, function(err, info) {
          t.assert(info === null);
          t.end(err);
        });
      });
    });
  });
}));

test('connect with comma-separated list of nodes', prepare(function(t, _) {
  var c = disque.connect(NODES.join(','));

  c.call('HELLO', function(err, res) {
    if (err)
      return t.end(err);

    t.assert(res.length > NODES.length)
    c.quit();
    t.end();
  });
}));

test('auth', prepare(function(t, _) {
  var password;

  var server = mock({
    hello: function() { return 'OK' },
    ping:  function() { return 'PONG' },
    quit:  function() {
      this.end();
      return '';
    },
    auth:  function(p) {
      password = p;
      return 'OK';
    }
  }).listen(7714);

  var c = disque.connect('127.0.0.1:7714', {auth: 'foobar'});

  c.call('PING', function(err, res) {
    if (err)
      return t.end(err);

    c.quit();
    server.close();

    t.equal(password, 'foobar');
    t.end();
  });
}));
