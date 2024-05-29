export const handler = async (state) => {
  const today = Date.now();
  const dev = getRandomDateAfter(today);
  const medium = getRandomDateAfter(dev);
  const hashnode = getRandomDateAfter(medium);

  return { dev, medium, hashnode };
};

const getRandomDateAfter = (inputDate) => {
  const date = new Date(inputDate);

  const additionalDays = Math.floor(Math.random() * 3) + 3;
  date.setDate(date.getDate() + additionalDays);

  // Ensure the date does not fall on a weekend
  while (date.getDay() === 0 || date.getDay() === 6) {
    date.setDate(date.getDate() + 1);
  }

  const randomHour = Math.floor(Math.random() * 3) + 16;
  date.setHours(randomHour, 0, 0, 0);

  return date.toISOString();
};
