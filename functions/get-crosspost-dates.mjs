export const handler = async (state) => {
  let lastPublishDate = Date.now();
  const crossPosts = {
    dev: 'DO NOT PUBLISH',
    medium: 'DO NOT PUBLISH',
    hashnode: 'DO NOT PUBLISH'
  };

  if(process.env.SHOULD_PUBLISH !== 'true') {
    return crossPosts;
  }

  if (state.crossPostTo.includes('dev')) {
    lastPublishDate = getRandomDateAfter(lastPublishDate);
    crossPosts.dev = lastPublishDate;
  }

  if (state.crossPostTo.includes('medium')) {
    lastPublishDate = getRandomDateAfter(lastPublishDate);
    crossPosts.medium = lastPublishDate;
  }

  if (state.crossPostTo.includes('hashnode')) {
    lastPublishDate = getRandomDateAfter(lastPublishDate);
    crossPosts.hashnode = lastPublishDate;
  }

  return crossPosts;
};

const getRandomDateAfter = (inputDate) => {
  const date = new Date(inputDate);

  switch (process.env.DELAY_TYPE) {
    case 'delay':
      const additionalDays = Math.floor(Math.random() * 3) + 3;
      date.setDate(date.getDate() + additionalDays);

      // Ensure the date does not fall on a weekend
      while (date.getDay() === 0 || date.getDay() === 6) {
        date.setDate(date.getDate() + 1);
      }

      const randomHour = Math.floor(Math.random() * 3) + 16;
      date.setHours(randomHour, 0, 0, 0);
      break;
    default:
      // all at once. Cross post now - which is the inputDate
      break;
  }

  return date.toISOString();
};
