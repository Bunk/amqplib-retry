/* eslint-disable max-lines */
const _ = require( "lodash" );
const sinon = require( "sinon" );
const sliver = require( "sliver" )( "amqplib.mocks" );

function setIfUndefined( object, prop, value ) {
	if ( !object[ prop ] ) {
		object[ prop ] = value;
	}
}

function findHandlers( connection, exchange, routingKey ) {
	if ( !exchange ) {
		return [];
	}

	return _( exchange.bindings )
		.filter( binding => binding.regex.test( routingKey ) )
		.flatMap( binding => {
			if ( binding.queueName ) {
				const queue = connection.queues[ binding.queueName ] || {};
				return [ queue.consumers ];
			}
			return findHandlers( connection.exchanges[ binding.exchangeName ] );
		} )
		.value();
}

async function routeMessages( consumers, message ) {
	await Promise.all( _.map( consumers, async handler => {
		return handler( message );
	} ) );
	return true;
}

class Channel {
	constructor( connection ) {
		this.id = sliver.getId();
		this.connection = connection;

		this.ack = sinon.stub();
		this.nack = sinon.stub();
		this.reject = sinon.stub();
		this.prefetch = sinon.stub();
		this.on = sinon.stub();
		this.once = sinon.stub();

		this.trackedMessages = [];
	}

	async assertQueue( queue, opt ) {
		setIfUndefined( this.connection.queues, queue, { messages: [], consumers: {}, options: opt } );
		return { queue, messageCount: 0, consumerCount: 0 };
	}

	async assertExchange( exchange, opt ) {
		setIfUndefined( this.connection.exchanges, exchange, { bindings: [], options: opt } );
		return { exchange };
	}

	async bindExchange( destination, source, pattern, args ) {
		if ( !this.connection.exchanges[ source ] ) {
			throw new Error( `Bind to non-existing exchange: ${ source }` );
		}
		const regex = new RegExp( `^${ pattern.replace( ".", "\\." ).replace( "#", "(\\w|\\.)+" ).replace( "*", "\\w+" ) }$` );
		this.connection.exchanges[ source ].bindings.push( { regex, exchangeName: destination } );
		return {};
	}

	async bindQueue( queue, exchange, pattern, args ) {
		if ( !this.connection.exchanges[ exchange ] ) {
			throw new Error( `Bind to non-existing exchange: ${ exchange }` );
		}
		pattern = pattern.replace( ".", "\\." ).replace( "#", "(\\w|\\.)+" ).replace( "*", "\\w+" );
		const regex = new RegExp( `^${ pattern }$` );
		this.connection.exchanges[ exchange ].bindings.push( { regex, queueName: queue } );
		return {};
	}

	async consume( queueName, handler ) {
		const queue = this.connection.queues[ queueName ];
		if ( !queue ) {
			throw new Error( `Consuming from non-existing queue: ${ queueName }` );
		}
		const consumerTag = sliver.getId();
		queue.consumers[ consumerTag ] = handler;
		return { consumerTag };
	}

	async publish( exchangeName, routingKey, content, properties ) {
		const exchange = this.connection.exchanges[ exchangeName ];
		if ( !exchange ) {
			throw new Error( `Publish to non-existing exchange: ${ exchangeName }` );
		}
		const consumers = findHandlers( exchange, routingKey );
		const message = { fields: { routingKey, exchange: exchangeName }, content, properties };
		this.trackedMessages.push( message );
		return routeMessages( consumers, message );
	}

	async sendToQueue( queueName, content, properties ) {
		const queue = this.connection.queues[ queueName ];
		if ( !queue ) {
			return true;
		}
		const message = { fields: { routingKey: queueName }, content, properties };
		this.trackedMessages.push( message );
		return routeMessages( queue.consumers, message );
	}

	// amqplib sends a null message when it receives a close event from Rabbit
	async closeConsumer( queueName ) {
		const queue = this.connection.queues[ queueName ];
		if ( !queue ) {
			return true;
		}
		return routeMessages( queue.consumers, null );
	}
}

module.exports = Channel;
