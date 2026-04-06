declare module 'snowball-stemmers' {
  export type SnowballStemmer = {
    stem(input: string): string;
  };

  export function newStemmer(
    algorithm:
      | 'english'
      | 'russian'
      | 'porter'
      | 'arabic'
      | 'armenian'
      | 'basque'
      | 'catalan'
      | 'czech'
      | 'danish'
      | 'dutch'
      | 'finnish'
      | 'french'
      | 'german'
      | 'hungarian'
      | 'italian'
      | 'irish'
      | 'norwegian'
      | 'portuguese'
      | 'romanian'
      | 'spanish'
      | 'slovene'
      | 'swedish'
      | 'tamil'
      | 'turkish'
  ): SnowballStemmer;

  export function algorithms(): string[];
}
