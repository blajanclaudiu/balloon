/**
 * @file Processors are used to prepare inputs (e.g., text, image or audio) for a model.
 *
 * **Example:** Using a `WhisperProcessor` to prepare an audio input for a model.
 * ```javascript
 * import { AutoProcessor, read_audio } from '@huggingface/transformers';
 *
 * let processor = await AutoProcessor.from_pretrained('openai/whisper-tiny.en');
 * let audio = await read_audio('https://huggingface.co/datasets/Narsil/asr_dummy/resolve/main/mlk.flac', 16000);
 * let { input_features } = await processor(audio);
 * // Tensor {
 * //   data: Float32Array(240000) [0.4752984642982483, 0.5597258806228638, 0.56434166431427, ...],
 * //   dims: [1, 80, 3000],
 * //   type: 'float32',
 * //   size: 240000,
 * // }
 * ```
 *
 * @module processors
 */
import { PROCESSOR_NAME } from '../utils/constants';
import { Callable } from '../utils/generic';
import { getModelJSON } from '../utils/hub';

/**
 * @typedef {Object} ProcessorProperties Additional processor-specific properties.
 * @typedef {import('../utils/hub.js').PretrainedOptions & ProcessorProperties} PretrainedProcessorOptions
 * @typedef {import('../tokenizers.js').PreTrainedTokenizer} PreTrainedTokenizer
 */

/**
 * Represents a Processor that extracts features from an input.
 */
export class Processor extends Callable {
  static classes = ['image_processor_class', 'tokenizer_class', 'feature_extractor_class'] as let;
  static uses_processor_config = false;

  static image_processor_class: any;
  static tokenizer_class: any;
  static feature_extractor_class: any;

  /**
   * Creates a new Processor with the given components
   * @param {Object} config
   * @param {Record<string, Object>} components
   */
  config: Record<string, any>;
  components: Record<string, any>;
  constructor(config: Record<string, any>, components: Record<string, any>) {
    super();
    this.config = config;
    this.components = components;
  }

  /**
   * @returns {import('./image_processors_utils.js').ImageProcessor|undefined} The image processor of the processor, if it exists.
   */
  get image_processor() {
    return this.components.image_processor;
  }

  /**
   * @returns {PreTrainedTokenizer|undefined} The tokenizer of the processor, if it exists.
   */
  get tokenizer() {
    return this.components.tokenizer;
  }

  /**
   * @returns {import('./feature_extraction_utils.js').FeatureExtractor|undefined} The feature extractor of the processor, if it exists.
   */
  get feature_extractor() {
    return this.components.feature_extractor;
  }

  /**
   * @param {Parameters<PreTrainedTokenizer['apply_chat_template']>[0]} messages
   * @param {Parameters<PreTrainedTokenizer['apply_chat_template']>[1]} options
   * @returns {ReturnType<PreTrainedTokenizer['apply_chat_template']>}
   */
  apply_chat_template(messages: any, options: any = {}) {
    if (!this.tokenizer) {
      throw new Error('Unable to apply chat template without a tokenizer.');
    }
    return this.tokenizer.apply_chat_template(messages, {
      tokenize: false, // default to false
      ...options,
    });
  }

  /**
   * @param {Parameters<PreTrainedTokenizer['batch_decode']>} args
   * @returns {ReturnType<PreTrainedTokenizer['batch_decode']>}
   */
  batch_decode(...args: any[]) {
    if (!this.tokenizer) {
      throw new Error('Unable to decode without a tokenizer.');
    }
    return this.tokenizer.batch_decode(...args);
  }

  /**
   * @param {Parameters<PreTrainedTokenizer['decode']>} args
   * @returns {ReturnType<PreTrainedTokenizer['decode']>}
   */
  decode(...args: any[]) {
    if (!this.tokenizer) {
      throw new Error('Unable to decode without a tokenizer.');
    }
    return this.tokenizer.decode(...args);
  }

  /**
   * Calls the feature_extractor function with the given input.
   * @param {any} input The input to extract features from.
   * @param {...any} args Additional arguments.
   * @returns {Promise<any>} A Promise that resolves with the extracted features.
   */
  async _call(input: any, ...args: any[]) {
    for (let item of [this.image_processor, this.feature_extractor, this.tokenizer]) {
      if (item) {
        return item(input, ...args);
      }
    }
    throw new Error('No image processor, feature extractor, or tokenizer found.');
  }

  /**
   * Instantiate one of the processor classes of the library from a pretrained model.
   *
   * The processor class to instantiate is selected based on the `image_processor_type` (or `feature_extractor_type`; legacy)
   * property of the config object (either passed as an argument or loaded from `pretrained_model_name_or_path` if possible)
   *
   * @param {string} pretrained_model_name_or_path The name or path of the pretrained model. Can be either:
   * - A string, the *model id* of a pretrained processor hosted inside a model repo on huggingface.co.
   *   Valid model ids can be located at the root-level, like `bert-base-uncased`, or namespaced under a
   *   user or organization name, like `dbmdz/bert-base-german-cased`.
   * - A path to a *directory* containing processor files, e.g., `./my_model_directory/`.
   * @param {PretrainedProcessorOptions} options Additional options for loading the processor.
   *
   * @returns {Promise<Processor>} A new instance of the Processor class.
   */
  static async from_pretrained(pretrained_model_name_or_path: string, options: any) {
    let [config, components] = await Promise.all([
      // TODO:
      this.uses_processor_config ? getModelJSON(pretrained_model_name_or_path, PROCESSOR_NAME, true, options) : {},
      Promise.all(
        this.classes
          .filter((cls) => cls in this)
          .map(async (cls) => {
            let component = await this[cls].from_pretrained(pretrained_model_name_or_path, options);
            return [cls.replace(/_class$/, ''), component];
          }),
      ).then(Object.fromEntries),
    ]);

    return new this(config, components);
  }
}
