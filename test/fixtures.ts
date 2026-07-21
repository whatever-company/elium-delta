import {
  runDeltaComposeEmbedFixtures,
  runDeltaDiffFixtures,
  runDeltaTransformEmbedFixtures,
  runDeltaInvertEmbedFixtures,
} from './fixture-runner';

// Run all fixture-driven tests
runDeltaComposeEmbedFixtures();
runDeltaDiffFixtures();
runDeltaTransformEmbedFixtures();
runDeltaInvertEmbedFixtures();
