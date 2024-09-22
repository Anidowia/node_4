const express = require('express');
const axios = require('axios');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config(); 

const app = express();
const PORT = 3000;

app.use(express.json());

// универсальные ф-ии для чтения/редактирования файла
const readFile = (filePath) => {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) {
        reject(`Ошибка при чтении файла ${filePath}: ` + err);
      } else {
        resolve(JSON.parse(data));
      }
    });
  });
};

const writeFile = (filePath, data) => {
  return new Promise((resolve, reject) => {
    fs.writeFile(filePath, JSON.stringify(data, null, 2), (err) => {
      if (err) {
        reject(`Ошибка при записи файла ${filePath}: ` + err);
      } else {
        resolve();
      }
    });
  });
};

const readManagersFromFile = () => readFile('managers.json');
const writeManagersToFile = (managers) => writeFile('managers.json', managers);

const readMoviesFromFile = () => readFile('top250.json');
const writeMoviesToFile = (movies) => writeFile('top250.json', movies);

//проверка токена
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(" ")[1] : null;

  if (!token) {
    return res.status(401).send('Токен не предоставлен.');
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const managers = await readManagersFromFile();
    const user = managers.find(manager => manager.id === decoded.id);

    if (!user) {
      return res.status(403).send('Пользователь не найден.');
    }

    req.user = user; // загрузка пользователя в req.user
    next(); 
  } 
  catch (error) {
    console.error('Ошибка при проверке токена:', error);
    res.status(403).send('Неверный токен.');
  }
};

//проверка доступа к READ операциям
const checkReadAccess = (req, res, next) => {
  if (req.user && req.user.super) {
    return next();
  }
  return res.status(403).send('Доступ запрещен.');
};

// проверка доступа к CREATE/UPDATE/DELETE операциям
const checkWriteAccess = (req, res, next) => {
  if (req.user && req.user.super) {
    return next();
  }
  return res.status(403).send('Доступ запрещен.');
};

app.use((req, res, next) => {
  if (req.path.startsWith('/api/auth/')) {
    return next();
  }
  authenticateToken(req, res, next);
});

app.get('/fetch-top250', checkReadAccess, async (req, res) => {
  try {
    // первые 250 фильмов по рейтингу с выведенными полями из модели по задаче, с бюджетом, сборами и рейтингом не равными 0
    const response = await axios.get('https://api.kinopoisk.dev/v1.4/movie?page=1&limit=250&selectFields=id&selectFields=name&selectFields=rating&selectFields=year&selectFields=budget&selectFields=fees&selectFields=poster&selectFields=top250&notNullFields=top250&notNullFields=budget.value&notNullFields=fees.world.value&sortField=top250&sortType=1&lists=top250', {
      headers: {
        'accept': 'application/json',
        'X-API-KEY': process.env.API_KEY
      }
    });

    // массив фильмов и преобразуем его в соответствии с моделью
    const movies = response.data.docs.map(movie => ({
      id: movie.id,
      title: movie.name, 
      rating: movie.rating.kp.toFixed(1).toString(), // оценка по кинопоиску
      year: movie.year, 
      budget: movie.budget.value, 
      gross: movie.fees.world.value, 
      poster: movie.poster.url, 
      position: movie.top250 
    }));

    fs.writeFile('top250.json', JSON.stringify(movies, null, 2), (err) => {
      if (err) {
        console.error('Ошибка при записи файла:', err);
        return res.status(500).send('Ошибка при записи файла.');
      }
      console.log('Данные успешно записаны в top250.json');
      res.send('Данные успешно записаны в top250.json');
    });
  } catch (error) {
    console.error('Ошибка при выполнении запроса:', error);
    res.status(500).send('Ошибка при выполнении запроса.');
  }
});

// GET /api/films/readall 
app.get('/api/films/readall', checkReadAccess, async (req, res) => {
  try {
    const movies = await readMoviesFromFile();
    const sortedMovies = movies.sort((a, b) => a.position - b.position);
    res.json(sortedMovies);
  } 
  catch (error) {
    console.error('Ошибка при обработке запроса:', error);
    res.status(500).send('Ошибка при обработке запроса.');
  }
});

// GET api/films/read
app.get('/api/films/read', checkReadAccess, async (req, res) => {
  try {
    const { id } = req.body;

    if (!id) {
      return res.status(400).send('Пожалуйста, укажите id фильма.');
    }

    const movies = await readMoviesFromFile();

    const movie = movies.find(movie => movie.id === id);

    if (movie) {
      res.json(movie);
    } else {
      res.status(404).send('Фильм с указанным id не найден.');
    }
  } catch (error) {
    console.error('Ошибка при обработке запроса:', error);
    res.status(500).send('Ошибка при обработке запроса.');
  }
});

// POST /api/films/create 
app.post('/api/films/create', checkReadAccess, async (req, res) => {
  try {
    const { title, rating, year, budget, gross, poster, position } = req.body;

    if (!title || !rating || !year || !budget || !gross || !poster || !position) {
      return res.status(400).send('Не все обязательные поля переданы.');
    }

    if (year < 1895) {
      return res.status(400).send('Дата фильма не может быть раньше 1895 года. Кинематограф ввели только в этом году!');
    }

    if (budget < 0 || gross < 0) {
      return res.status(400).send('Бюджет и сборы не могут быть отрицательными.');
    }

    let movies = await readMoviesFromFile();

    // Проверяем, есть ли пробелы между существующими позициями
    const sortedMovies = movies.sort((a, b) => a.position - b.position);
    let newPosition = position;

    // Проверяем наличие пробелов и выбираем ближайшую позицию
    for (let i = 0; i < sortedMovies.length - 1; i++) {
      if (sortedMovies[i].position < newPosition && sortedMovies[i + 1].position > newPosition) {
        if (newPosition > sortedMovies[i].position + 1) {
          newPosition = sortedMovies[i].position + 1;
        }
        break;
      }
    }

    const newMovie = {
      id: Math.round(Date.now() + Math.random() * 1000),
      title,
      rating,
      year,
      budget,
      gross,
      poster,
      position: newPosition
    };

    movies.push(newMovie);
    movies.sort((a, b) => a.position - b.position);

    await writeMoviesToFile(movies);

    res.status(201).json(newMovie);
  } 
  catch (error) {
    console.error('Ошибка при создании фильма:', error);
    res.status(500).send('Ошибка при создании фильма.');
  }
});

// POST /api/films/update 
app.post('/api/films/update', checkReadAccess, async (req, res) => {
  try {
    const { id, title, rating, year, budget, gross, poster, position } = req.body;

    if (!id) {
      return res.status(400).send('id фильма не передан.');
    }

    if (year < 1895) {
      return res.status(400).send('Дата фильма не может быть раньше 1895 года.');
    }

    if (budget < 0 || gross < 0) {
      return res.status(400).send('Бюджет и сборы не могут быть отрицательными.');
    }

    let movies = await readMoviesFromFile();
    const movieIndex = movies.findIndex(movie => movie.id === id);

    if (movieIndex === -1) {
      return res.status(404).send('Фильм с данным id не найден.');
    }

    const oldPosition = movies[movieIndex].position;

    // Обновляем поля фильма
    if (title !== undefined) movies[movieIndex].title = title;
    if (rating !== undefined) movies[movieIndex].rating = rating;
    if (year !== undefined) movies[movieIndex].year = year;
    if (budget !== undefined) movies[movieIndex].budget = budget;
    if (gross !== undefined) movies[movieIndex].gross = gross;
    if (poster !== undefined) movies[movieIndex].poster = poster;

    // Если позиция изменена, проверяем пробелы
    if (position !== undefined && position !== oldPosition) {
      let newPosition = position;
      const sortedMovies = movies.sort((a, b) => a.position - b.position);

      for (let i = 0; i < sortedMovies.length - 1; i++) {
        if (sortedMovies[i].position < newPosition && sortedMovies[i + 1].position > newPosition) {
          if (newPosition > sortedMovies[i].position + 1) {
            newPosition = sortedMovies[i].position + 1;
          }
          break;
        }
      }

      movies[movieIndex].position = newPosition;
    }

    movies.sort((a, b) => a.position - b.position);
    await writeMoviesToFile(movies);

    res.status(200).json(movies[movieIndex]);
  } 
  catch (error) {
    console.error('Ошибка при обновлении фильма:', error);
    res.status(500).send('Ошибка при обновлении фильма.');
  }
});

// POST /api/films/delete 
app.post('/api/films/delete', checkReadAccess, async (req, res) => {
  try {
    const { id } = req.body;

    if (!id) {
      return res.status(400).send('id фильма не передан.');
    }

    let movies = await readMoviesFromFile();
    const movieIndex = movies.findIndex(movie => movie.id === id);

    if (movieIndex === -1) {
      return res.status(404).send('Фильм с данным id не найден.');
    }

    const deletedMoviePosition = movies[movieIndex].position;
    movies.splice(movieIndex, 1);

    // cдвигаем фильмы, чтобы не было пробелов в позициях
    movies = movies.map(movie => {
      if (movie.position > deletedMoviePosition) {
        movie.position -= 1; 
      }
      return movie;
    });

    await writeMoviesToFile(movies);
    res.status(200).send(`Фильм с id ${id} успешно удален.`);
  } 
  catch (error) {
    console.error('Ошибка при удалении фильма:', error);
    res.status(500).send('Ошибка при удалении фильма.');
  }
});

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).send('Пожалуйста, укажите email и пароль.');
    }

    let managers = await readManagersFromFile();

    const existingManager = managers.find(manager => manager.email === email);
    if (existingManager) {
      return res.status(400).send('Менеджер с таким email уже существует.');
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newManager = {
      id: Math.round(Date.now() + Math.random() * 1000), 
      email,
      password: hashedPassword, 
      super: false
    };

    managers.push(newManager);
    await writeManagersToFile(managers);

    res.status(201).send('Менеджер успешно зарегистрирован.');
  } 
  catch (error) {
    console.error('Ошибка при регистрации менеджера:', error);
    res.status(500).send('Ошибка при регистрации менеджера.');
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).send('Пожалуйста, укажите email и пароль.');
    }

    let managers = await readManagersFromFile();

    const manager = managers.find(manager => manager.email === email);
    if (!manager) {
      return res.status(404).send('Менеджер с таким email не найден.');
    }

    const isPasswordValid = await bcrypt.compare(password, manager.password);
    if (!isPasswordValid) {
      return res.status(400).send('Неверный пароль.');
    }

    const token = jwt.sign(
      { id: manager.id, email: manager.email }, 
      process.env.JWT_SECRET,
      { expiresIn: '5m' } // Время жизни токена 5 минут
    );

    res.status(200).json({ token });
    } 
  catch (error) {
    console.error('Ошибка при аутентификации менеджера:', error);
    res.status(500).send('Ошибка при аутентификации менеджера.');
  }
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});


