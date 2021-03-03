import 'mocha';
import { KafkaJsInstrumentation, KafkaJsInstrumentationConfig } from '../src';
import { InMemorySpanExporter, SimpleSpanProcessor, ReadableSpan } from '@opentelemetry/tracing';
import { NodeTracerProvider } from '@opentelemetry/node';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { ContextManager } from '@opentelemetry/context-base';
import { context, propagation, SpanKind, SpanStatusCode, Span } from '@opentelemetry/api';
import { MessagingAttribute } from '@opentelemetry/semantic-conventions';
import expect from 'expect';

const instrumentation = new KafkaJsInstrumentation();

import * as kafkajs from 'kafkajs';
import {
    Kafka,
    ProducerRecord,
    RecordMetadata,
    Producer,
    ProducerBatch,
    Message,
    Consumer,
    ConsumerRunConfig,
    EachBatchPayload,
    EachMessagePayload,
    KafkaMessage,
} from 'kafkajs';
import { DummyPropagation } from './DummyPropagation';

describe('instrumentation-kafkajs', () => {
    const provider = new NodeTracerProvider();
    const memoryExporter = new InMemorySpanExporter();
    const spanProcessor = new SimpleSpanProcessor(memoryExporter);
    propagation.setGlobalPropagator(new DummyPropagation());
    provider.addSpanProcessor(spanProcessor);
    instrumentation.setTracerProvider(provider);
    let contextManager: ContextManager;

    const kafka = new Kafka({
        clientId: 'unit-tests',
        brokers: ['testing_mock_host:1234'],
    });

    let producer: Producer;
    let messagesSent: Message[] = [];

    const patchProducerSend = (cb: () => Promise<RecordMetadata[]>) => {
        const origProducerFactory = kafkajs.Kafka.prototype.producer;
        kafkajs.Kafka.prototype.producer = function (): Producer {
            const producer = origProducerFactory.apply(this, arguments);

            producer.send = function (record: ProducerRecord) {
                messagesSent.push(...record.messages);
                return cb();
            };

            producer.sendBatch = function (batch: ProducerBatch) {
                batch.topicMessages.forEach((topicMessages) => messagesSent.push(...topicMessages.messages));
                return cb();
            };

            return producer;
        };
    };

    let consumer: Consumer;
    let runConfig: ConsumerRunConfig;

    const storeRunConfig = () => {
        const origConsumerFactory = kafkajs.Kafka.prototype.consumer;
        kafkajs.Kafka.prototype.consumer = function (): Consumer {
            const consumer: Consumer = origConsumerFactory.apply(this, arguments);
            consumer.run = function (config?: ConsumerRunConfig): Promise<void> {
                runConfig = config;
                return Promise.resolve();
            };
            return consumer;
        };
    };

    beforeEach(() => {
        messagesSent = [];
        contextManager = new AsyncHooksContextManager().enable();
        context.setGlobalContextManager(contextManager);
    });

    afterEach(() => {
        memoryExporter.reset();
        contextManager.disable();
    });

    describe('producer', () => {
        const expectKafkaHeadersToMatchSpanContext = (kafkaMessage: Message, span: ReadableSpan) => {
            expect(kafkaMessage.headers[DummyPropagation.TRACE_CONTEXT_KEY]).toStrictEqual(span.spanContext.traceId);
            expect(kafkaMessage.headers[DummyPropagation.SPAN_CONTEXT_KEY]).toStrictEqual(span.spanContext.spanId);
        };

        describe('successful send', () => {
            beforeEach(async () => {
                patchProducerSend(
                    async (): Promise<RecordMetadata[]> => {
                        return [
                            {
                                topicName: 'topic-name-1',
                                partition: 0,
                                errorCode: 123,
                                offset: '18',
                                timestamp: '123456',
                            },
                        ];
                    }
                );
                instrumentation.disable();
                instrumentation.enable();
                producer = kafka.producer();
            });

            it('simple send create span with right attributes, pass return value correctly and propagate context', async () => {
                const res: RecordMetadata[] = await producer.send({
                    topic: 'topic-name-1',
                    messages: [
                        {
                            value: 'testing message content',
                        },
                    ],
                });

                expect(res.length).toBe(1);
                expect(res[0].topicName).toStrictEqual('topic-name-1');

                const spans = memoryExporter.getFinishedSpans();
                expect(spans.length).toBe(1);
                const span = spans[0];
                expect(span.kind).toStrictEqual(SpanKind.PRODUCER);
                expect(span.name).toStrictEqual('topic-name-1');
                expect(span.status.code).toStrictEqual(SpanStatusCode.UNSET);
                expect(span.attributes[MessagingAttribute.MESSAGING_SYSTEM]).toStrictEqual('kafka');
                expect(span.attributes[MessagingAttribute.MESSAGING_DESTINATION_KIND]).toStrictEqual('topic');
                expect(span.attributes[MessagingAttribute.MESSAGING_DESTINATION]).toStrictEqual('topic-name-1');

                expect(messagesSent.length).toBe(1);
                expectKafkaHeadersToMatchSpanContext(messagesSent[0], span);
            });

            it('send two messages', async () => {
                await producer.send({
                    topic: 'topic-name-1',
                    messages: [
                        {
                            value: 'message1',
                        },
                        {
                            value: 'message2',
                        },
                    ],
                });

                const spans = memoryExporter.getFinishedSpans();
                expect(spans.length).toBe(2);
                expect(spans[0].name).toStrictEqual('topic-name-1');
                expect(spans[1].name).toStrictEqual('topic-name-1');

                expect(messagesSent.length).toBe(2);
                expectKafkaHeadersToMatchSpanContext(messagesSent[0], spans[0]);
                expectKafkaHeadersToMatchSpanContext(messagesSent[1], spans[1]);
            });

            it('send batch', async () => {
                await producer.sendBatch({
                    topicMessages: [
                        {
                            topic: 'topic-name-1',
                            messages: [
                                {
                                    value: 'message1-1',
                                },
                                {
                                    value: 'message1-2',
                                },
                            ],
                        },
                        {
                            topic: 'topic-name-2',
                            messages: [
                                {
                                    value: 'message2-1',
                                },
                            ],
                        },
                    ],
                });

                const spans = memoryExporter.getFinishedSpans();
                expect(spans.length).toBe(3);
                expect(spans[0].name).toStrictEqual('topic-name-1');
                expect(spans[1].name).toStrictEqual('topic-name-1');
                expect(spans[2].name).toStrictEqual('topic-name-2');

                expect(messagesSent.length).toBe(3);
                for (let i = 0; i < 3; i++) {
                    expectKafkaHeadersToMatchSpanContext(messagesSent[i], spans[i]);
                }
            });
        });

        describe('failed send', () => {
            beforeEach(async () => {
                patchProducerSend(
                    (): Promise<RecordMetadata[]> => {
                        return Promise.reject(new Error('error thrown from kafka client send'));
                    }
                );
                instrumentation.disable();
                instrumentation.enable();
                producer = kafka.producer();
            });

            it('error in send create failed span', async () => {
                try {
                    await producer.send({
                        topic: 'topic-name-1',
                        messages: [
                            {
                                value: 'testing message content',
                            },
                        ],
                    });
                } catch (err) {}

                const spans = memoryExporter.getFinishedSpans();
                expect(spans.length).toBe(1);
                const span = spans[0];
                expect(span.status.code).toStrictEqual(SpanStatusCode.ERROR);
                expect(span.status.message).toStrictEqual('error thrown from kafka client send');
            });

            it('error in send with multiple messages create failed spans', async () => {
                try {
                    await producer.send({
                        topic: 'topic-name-1',
                        messages: [
                            {
                                value: 'testing message content 1',
                            },
                            {
                                value: 'testing message content 2',
                            },
                        ],
                    });
                } catch (err) {}

                const spans = memoryExporter.getFinishedSpans();
                expect(spans.length).toBe(2);
                spans.forEach((span) => {
                    expect(span.status.code).toStrictEqual(SpanStatusCode.ERROR);
                    expect(span.status.message).toStrictEqual('error thrown from kafka client send');
                });
            });

            it('error in sendBatch should set error to all spans', async () => {
                try {
                    await producer.sendBatch({
                        topicMessages: [
                            {
                                topic: 'topic-name-1',
                                messages: [
                                    {
                                        value: 'message1-1',
                                    },
                                    {
                                        value: 'message1-2',
                                    },
                                ],
                            },
                            {
                                topic: 'topic-name-2',
                                messages: [
                                    {
                                        value: 'message2-1',
                                    },
                                ],
                            },
                        ],
                    });
                } catch (err) {}

                const spans = memoryExporter.getFinishedSpans();
                expect(spans.length).toBe(3);
                spans.forEach((span) => {
                    expect(span.status.code).toStrictEqual(SpanStatusCode.ERROR);
                    expect(span.status.message).toStrictEqual('error thrown from kafka client send');
                });
            });
        });

        describe('producer hook successful', () => {
            beforeEach(async () => {
                patchProducerSend(async (): Promise<RecordMetadata[]> => []);

                const config: KafkaJsInstrumentationConfig = {
                    producerHook: (span: Span, topic: string, message: Message) => {
                        span.setAttribute('attribute-from-hook', message.value as string);
                    },
                };
                instrumentation.disable();
                instrumentation.setConfig(config);
                instrumentation.enable();
                producer = kafka.producer();
            });

            it('producer hook add span attribute with value from message', async () => {
                await producer.send({
                    topic: 'topic-name-1',
                    messages: [
                        {
                            value: 'testing message content',
                        },
                    ],
                });

                const spans = memoryExporter.getFinishedSpans();
                expect(spans.length).toBe(1);
                const span = spans[0];
                expect(span.attributes['attribute-from-hook']).toStrictEqual('testing message content');
            });
        });

        describe('producer hook throw, should still create span', () => {
            beforeEach(async () => {
                patchProducerSend(async (): Promise<RecordMetadata[]> => []);

                const config: KafkaJsInstrumentationConfig = {
                    producerHook: (span: Span, topic: string, message: Message) => {
                        throw new Error('error thrown from producer hook');
                    },
                };
                instrumentation.disable();
                instrumentation.setConfig(config);
                instrumentation.enable();
                producer = kafka.producer();
            });

            it('producer hook add span attribute with value from message', async () => {
                await producer.send({
                    topic: 'topic-name-1',
                    messages: [
                        {
                            value: 'testing message content',
                        },
                    ],
                });

                const spans = memoryExporter.getFinishedSpans();
                expect(spans.length).toBe(1);
                const span = spans[0];
                expect(span.status.code).toStrictEqual(SpanStatusCode.UNSET);
            });
        });

        describe('moduleVersionAttributeName config', () => {
            beforeEach(async () => {
                const config: KafkaJsInstrumentationConfig = {
                    moduleVersionAttributeName: 'module.version'
                };
                instrumentation.disable();
                instrumentation.setConfig(config);
                instrumentation.enable();
                producer = kafka.producer();
            });
    
            it('adds module version to producer span', async () => {
                await producer.send({
                    topic: 'topic-name-1',
                    messages: [{ value: 'testing message content' }],
                });

                const spans = memoryExporter.getFinishedSpans();
                expect(spans.length).toBe(1);
                const span = spans[0];
                expect(span.attributes['module.version']).toMatch(/\d{1,4}\.\d{1,4}\.\d{1,5}.*/);
            });
        });
    });

    describe('consumer', () => {
        const createKafkaMessage = (offset): KafkaMessage => {
            return {
                key: Buffer.from('message-key', 'utf8'),
                value: Buffer.from('message content', 'utf8'),
                timestamp: '1234',
                size: 10,
                attributes: 1,
                offset: offset,
            };
        };

        const createEachMessagePayload = (): EachMessagePayload => {
            return {
                topic: 'topic-name-1',
                partition: 0,
                message: createKafkaMessage('123'),
            };
        };

        const createEachBatchPayload = (): EachBatchPayload => {
            return {
                batch: {
                    topic: 'topic-name-1',
                    partition: 1234,
                    highWatermark: '4567',
                    messages: [createKafkaMessage('124'), createKafkaMessage('125')],
                },
            } as EachBatchPayload;
        };

        beforeEach(() => {
            storeRunConfig();
        });

        describe('successful eachMessage', () => {
            beforeEach(async () => {
                instrumentation.disable();
                instrumentation.enable();
                consumer = kafka.consumer({
                    groupId: 'testing-group-id',
                });
                consumer.run({
                    eachMessage: async (payload: EachMessagePayload): Promise<void> => {},
                });
            });

            it('consume eachMessage create span with expected attributes', async () => {
                const payload: EachMessagePayload = createEachMessagePayload();
                await runConfig.eachMessage(payload);

                const spans = memoryExporter.getFinishedSpans();
                expect(spans.length).toBe(1);
                const span = spans[0];
                expect(span.name).toStrictEqual('topic-name-1');
                expect(span.parentSpanId).toBeUndefined();
                expect(span.kind).toStrictEqual(SpanKind.CONSUMER);
                expect(span.status.code).toStrictEqual(SpanStatusCode.UNSET);
                expect(span.attributes[MessagingAttribute.MESSAGING_SYSTEM]).toStrictEqual('kafka');
                expect(span.attributes[MessagingAttribute.MESSAGING_DESTINATION_KIND]).toStrictEqual('topic');
                expect(span.attributes[MessagingAttribute.MESSAGING_DESTINATION]).toStrictEqual('topic-name-1');
                expect(span.attributes[MessagingAttribute.MESSAGING_OPERATION]).toStrictEqual('process');
            });
        });

        describe('successful consumer hook', () => {
            beforeEach(async () => {
                const config: KafkaJsInstrumentationConfig = {
                    consumerHook: (span: Span, topic: string, message: Message) => {
                        span.setAttribute('attribute key from hook', message.value.toString());
                    },
                };
                instrumentation.disable();
                instrumentation.setConfig(config);
                instrumentation.enable();
                consumer = kafka.consumer({
                    groupId: 'testing-group-id',
                });
                consumer.run({
                    eachMessage: async (payload: EachMessagePayload): Promise<void> => {},
                });
            });

            it('consume hook adds attribute to span', async () => {
                const payload: EachMessagePayload = createEachMessagePayload();
                await runConfig.eachMessage(payload);

                const spans = memoryExporter.getFinishedSpans();
                expect(spans.length).toBe(1);
                const span = spans[0];
                expect(span.attributes['attribute key from hook']).toStrictEqual(payload.message.value.toString());
            });
        });

        describe('throwing consumer hook', () => {
            beforeEach(async () => {
                const config: KafkaJsInstrumentationConfig = {
                    consumerHook: (span: Span, topic: string, message: Message) => {
                        throw new Error('error thrown from consumer hook');
                    },
                };
                instrumentation.disable();
                instrumentation.setConfig(config);
                instrumentation.enable();
                consumer = kafka.consumer({
                    groupId: 'testing-group-id',
                });
                consumer.run({
                    eachMessage: async (payload: EachMessagePayload): Promise<void> => {},
                });
            });

            it('consume hook adds attribute to span', async () => {
                const payload: EachMessagePayload = createEachMessagePayload();
                await runConfig.eachMessage(payload);

                const spans = memoryExporter.getFinishedSpans();
                // span should still be created
                expect(spans.length).toBe(1);
            });
        });

        describe('eachMessage throws', () => {
            beforeEach(async () => {
                instrumentation.disable();
                instrumentation.enable();
                consumer = kafka.consumer({
                    groupId: 'testing-group-id',
                });
            });

            it('Error message written in the span status', async () => {
                const errorToThrow = new Error('error thrown from eachMessage callback');
                consumer.run({
                    eachMessage: async (payload: EachMessagePayload): Promise<void> => {
                        throw errorToThrow;
                    },
                });

                const payload: EachMessagePayload = createEachMessagePayload();
                let exception;
                try {
                    await runConfig.eachMessage(payload);
                } catch (e) {
                    exception = e;
                }
                expect(exception).toEqual(errorToThrow);

                const spans = memoryExporter.getFinishedSpans();
                expect(spans.length).toBe(1);
                const span = spans[0];
                expect(span.status.code).toStrictEqual(SpanStatusCode.ERROR);
                expect(span.status.message).toStrictEqual('error thrown from eachMessage callback');
            });

            it('throwing object with no message', async () => {
                const objectToThrow = {
                    nonMessageProperty: 'the thrown object has no `message` property',
                };
                consumer.run({
                    eachMessage: async (payload: EachMessagePayload): Promise<void> => {
                        throw objectToThrow;
                    },
                });

                const payload: EachMessagePayload = createEachMessagePayload();
                let exception;
                try {
                    await runConfig.eachMessage(payload);
                } catch (e) {
                    exception = e;
                }
                expect(exception).toEqual(objectToThrow);

                const spans = memoryExporter.getFinishedSpans();
                expect(spans.length).toBe(1);
                const span = spans[0];
                expect(span.status.code).toStrictEqual(SpanStatusCode.ERROR);
                expect(span.status.message).toBeUndefined();
            });

            it('throwing non object', async () => {
                consumer.run({
                    eachMessage: async (payload: EachMessagePayload): Promise<void> => {
                        throw undefined;
                    },
                });

                const payload: EachMessagePayload = createEachMessagePayload();
                let exception = null;
                try {
                    await runConfig.eachMessage(payload);
                } catch (e) {
                    exception = e;
                }
                expect(exception).toBeUndefined();

                const spans = memoryExporter.getFinishedSpans();
                expect(spans.length).toBe(1);
                const span = spans[0];
                expect(span.status.code).toStrictEqual(SpanStatusCode.ERROR);
                expect(span.status.message).toBeUndefined();
            });
        });

        describe('successful eachBatch', () => {
            beforeEach(async () => {
                instrumentation.disable();
                instrumentation.enable();
                consumer = kafka.consumer({
                    groupId: 'testing-group-id',
                });
                consumer.run({
                    eachBatch: async (payload: EachBatchPayload): Promise<void> => {},
                });
            });

            it('consume eachBatch create span with expected attributes', async () => {
                const payload: EachBatchPayload = createEachBatchPayload();
                await runConfig.eachBatch(payload);

                const spans = memoryExporter.getFinishedSpans();
                expect(spans.length).toBe(3);
                spans.forEach((span) => {
                    expect(span.name).toStrictEqual('topic-name-1');
                    expect(span.status.code).toStrictEqual(SpanStatusCode.UNSET);
                    expect(span.attributes[MessagingAttribute.MESSAGING_SYSTEM]).toStrictEqual('kafka');
                    expect(span.attributes[MessagingAttribute.MESSAGING_DESTINATION_KIND]).toStrictEqual('topic');
                    expect(span.attributes[MessagingAttribute.MESSAGING_DESTINATION]).toStrictEqual('topic-name-1');
                });

                const [recvSpan, msg1Span, msg2Span] = spans;

                expect(recvSpan.parentSpanId).toBeUndefined();
                expect(recvSpan.attributes[MessagingAttribute.MESSAGING_OPERATION]).toStrictEqual('receive');

                expect(msg1Span.parentSpanId).toStrictEqual(recvSpan.spanContext.spanId);
                expect(msg1Span.attributes[MessagingAttribute.MESSAGING_OPERATION]).toStrictEqual('process');

                expect(msg2Span.parentSpanId).toStrictEqual(recvSpan.spanContext.spanId);
                expect(msg2Span.attributes[MessagingAttribute.MESSAGING_OPERATION]).toStrictEqual('process');
            });
        });

        describe('moduleVersionAttributeName config', () => {
            beforeEach(async () => {
                const config: KafkaJsInstrumentationConfig = {
                    moduleVersionAttributeName: 'module.version'
                };
                instrumentation.disable();
                instrumentation.setConfig(config);
                instrumentation.enable();
                consumer = kafka.consumer({
                    groupId: 'testing-group-id',
                });
                consumer.run({
                    eachMessage: async (payload: EachMessagePayload): Promise<void> => {},
                });
            });
    
            it('adds module version to consumer span', async () => {
                const payload: EachMessagePayload = createEachMessagePayload();
                await runConfig.eachMessage(payload);
    
                const spans = memoryExporter.getFinishedSpans();
                expect(spans.length).toBe(1);
                const span = spans[0];
                expect(span.attributes['module.version']).toMatch(/\d{1,4}\.\d{1,4}\.\d{1,5}.*/);
            });
        });
    });

    describe('context propagation', () => {
        beforeEach(() => {
            patchProducerSend(async (): Promise<RecordMetadata[]> => []);
            storeRunConfig();
            instrumentation.disable();
            instrumentation.enable();
            producer = kafka.producer();
            consumer = kafka.consumer({ groupId: 'testing-group-id' });
        });

        it('context injected in producer is extracted in consumer', async () => {
            consumer.run({
                eachMessage: async (payload: EachMessagePayload): Promise<void> => {},
            });

            await producer.send({
                topic: 'topic-name-1',
                messages: [
                    {
                        value: 'testing message content',
                    },
                ],
            });

            expect(messagesSent.length).toBe(1);
            const consumerPayload: EachMessagePayload = {
                topic: 'topic-name-1',
                partition: 0,
                message: {
                    key: Buffer.alloc(0),
                    value: Buffer.alloc(0),
                    timestamp: '1234',
                    size: 0,
                    attributes: 0,
                    offset: '0',
                    headers: messagesSent[0].headers,
                },
            };
            await runConfig.eachMessage(consumerPayload);

            const spans = memoryExporter.getFinishedSpans();
            expect(spans.length).toBe(2);
            const [producerSpan, consumerSpan] = spans;
            expect(consumerSpan.spanContext.traceId).toStrictEqual(producerSpan.spanContext.traceId);
            expect(consumerSpan.parentSpanId).toStrictEqual(producerSpan.spanContext.spanId);
        });

        it('context injected in producer is extracted as links in batch consumer', async () => {
            consumer.run({
                eachBatch: async (payload: EachBatchPayload): Promise<void> => {},
            });

            await producer.send({
                topic: 'topic-name-1',
                messages: [
                    {
                        value: 'testing message content',
                    },
                ],
            });

            expect(messagesSent.length).toBe(1);
            const consumerPayload: EachBatchPayload = {
                batch: {
                    topic: 'topic-name-1',
                    partition: 0,
                    highWatermark: '1234',
                    messages: [
                        {
                            key: Buffer.alloc(0),
                            value: Buffer.alloc(0),
                            timestamp: '1234',
                            size: 0,
                            attributes: 0,
                            offset: '0',
                            headers: messagesSent[0].headers,
                        },
                    ],
                },
            } as EachBatchPayload;
            await runConfig.eachBatch(consumerPayload);

            const spans = memoryExporter.getFinishedSpans();
            expect(spans.length).toBe(3);
            const [producerSpan, receivingSpan, processingSpan] = spans;

            // processing span should be the child of receiving span and link to relevant producer
            expect(processingSpan.spanContext.traceId).toStrictEqual(receivingSpan.spanContext.traceId);
            expect(processingSpan.parentSpanId).toStrictEqual(receivingSpan.spanContext.spanId);
            expect(processingSpan.links.length).toBe(1);
            expect(processingSpan.links[0].context.traceId).toStrictEqual(producerSpan.spanContext.traceId);
            expect(processingSpan.links[0].context.spanId).toStrictEqual(producerSpan.spanContext.spanId);

            // receiving span should start a new trace
            expect(receivingSpan.parentSpanId).toBeUndefined();
            expect(receivingSpan.spanContext.traceId).not.toStrictEqual(producerSpan.spanContext.traceId);
        });
    });
});