// Plausible UK musician names. Mix of first names + surnames sampled from
// rough UK demographic distributions. The simulator combines a first name
// with a surname (and occasionally an "act name" alias) so each sim user
// has a believable display_name + name pair.

const FIRST_NAMES = [
  'Alex', 'Sam', 'Jordan', 'Charlie', 'Casey', 'Robin', 'Morgan', 'Frankie',
  'James', 'Tom', 'Daniel', 'Oliver', 'Harry', 'Jack', 'Ben', 'Lewis', 'Joe',
  'Sophie', 'Emma', 'Olivia', 'Hannah', 'Ella', 'Grace', 'Lucy', 'Eve',
  'Rachel', 'Sarah', 'Megan', 'Amy', 'Beth', 'Imogen', 'Maya',
  'David', 'Michael', 'Andrew', 'Paul', 'Chris', 'Matt', 'Ryan', 'Adam',
  'Laura', 'Claire', 'Helen', 'Nicola', 'Sophie', 'Rebecca', 'Anna',
  'Aisha', 'Priya', 'Yusuf', 'Mohammed', 'Hassan', 'Fatima', 'Zara',
  'Kwame', 'Femi', 'Chioma', 'Nia', 'Joel', 'Marcus', 'Tyrone',
  'Niamh', 'Aoife', 'Saoirse', 'Cara', 'Sean', 'Connor', 'Ronan',
  'Rhys', 'Bethan', 'Iolo', 'Eleri',
  'Fraser', 'Hamish', 'Iona', 'Catriona',
];

const SURNAMES = [
  'Smith', 'Jones', 'Williams', 'Brown', 'Taylor', 'Davies', 'Wilson',
  'Evans', 'Thomas', 'Roberts', 'Johnson', 'Walker', 'Wright', 'Robinson',
  'Thompson', 'White', 'Hughes', 'Edwards', 'Green', 'Hall', 'Wood',
  'Harris', 'Martin', 'Jackson', 'Clarke', 'Clark', 'Turner', 'Hill',
  'Scott', 'Cooper', 'Ward', 'Morris', 'Moore', 'King', 'Lee',
  'Patel', 'Khan', 'Singh', 'Begum', 'Shah', 'Ahmed', 'Ali',
  'Murphy', 'Kelly', 'O’Brien', 'Ryan', 'Byrne', 'Doherty',
  'MacLeod', 'Campbell', 'Stewart', 'Fraser', 'Anderson',
  'Lewis', 'Morgan', 'Bevan', 'Pugh', 'Llewellyn',
  'Adeyemi', 'Okonkwo', 'Mensah',
];

const ACT_PREFIXES = ['The', 'Mr', 'DJ', 'Captain'];
const ACT_NOUNS = ['Foxes', 'Tigers', 'Vibe', 'Sessions', 'Trio', 'Quartet',
  'Band', 'Collective', 'Project', 'Affair', 'Strings', 'Brass', 'Keys'];

function pickName(rand) {
  rand = rand || Math.random;
  const first = FIRST_NAMES[Math.floor(rand() * FIRST_NAMES.length)];
  const last = SURNAMES[Math.floor(rand() * SURNAMES.length)];
  // 15% of users have an act name distinct from their display name
  let act_name = null;
  if (rand() < 0.15) {
    const usePrefix = rand() < 0.4;
    const noun = ACT_NOUNS[Math.floor(rand() * ACT_NOUNS.length)];
    if (usePrefix) {
      const pre = ACT_PREFIXES[Math.floor(rand() * ACT_PREFIXES.length)];
      act_name = `${pre} ${first}'s ${noun}`;
    } else {
      act_name = `${first} ${last} ${noun}`;
    }
  }
  return {
    display_name: `${first} ${last}`,
    // `name` is the legacy column the directory uses as primary identifier;
    // we let act_name override it when present so the directory shows
    // "The Foxes Trio" instead of "Alex Smith" for those users.
    name: act_name || `${first} ${last}`,
  };
}

module.exports = { FIRST_NAMES, SURNAMES, pickName };
